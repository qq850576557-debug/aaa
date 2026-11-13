import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createMiniPhotoSidecar } from './miniprogram-sidecar';
import { fixtureAccounts, fixtureQuery } from './test-fixtures';
import { pool, privatePool } from './db';
import { wgsToGcj } from '../src/lib/photo-location';

test('observed legacy 2756068 API keeps real employee sessions/CSRF/POI and cross-account permissions through sidecar', async () => {
  if (process.env.APP_ENV !== 'test' || !process.env.CHUNMO_LEGACY_APP_BUNDLE)
    throw Error('Use scripts/test-miniprogram-legacy.mjs with dedicated local _test databases');
  const legacy = await import(pathToFileURL(process.env.CHUNMO_LEGACY_APP_BUNDLE).href);
  const originalFetch = globalThis.fetch;
  const point = {
    latitude: 30.286,
    longitude: 120.123,
    accuracy: 18,
    obtainedAt: new Date().toISOString(),
  };
  process.env.CHUNMO_AMAP_ENABLED = '1';
  process.env.CHUNMO_AMAP_KEY = 'synthetic-test-only';
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (String(input).startsWith('https://restapi.amap.com/v3/place/around')) {
      const p = wgsToGcj(point.latitude, point.longitude);
      return Response.json({
        status: '1',
        count: '1',
        pois: [
          {
            id: 'fixture-poi',
            name: '隔离测试地点',
            address: '仅测试',
            location: `${p.longitude},${p.latitude}`,
          },
        ],
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const old = createServer(legacy.createApp());
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
  const appId = 'wx1234567890abcdef';
  const sidecar = createMiniPhotoSidecar({
    enabled: true,
    appId,
    appSecret: 'fixture-only',
    signingKey: 'fixture-'.repeat(8),
    origin: process.env.APP_ORIGIN!,
    apiPort: (old.address() as { port: number }).port,
    exchange: async (code) => (code === 'test-code' ? { openid: 'test-wx' } : { errcode: 40029 }),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => sidecar.once('listening', r));
  const base = 'http://127.0.0.1:' + (sidecar.address() as { port: number }).port;
  type Client = { proof: string; cookie?: string; csrf?: string };
  const req = (route: string, body?: unknown, client?: Client) =>
    fetch(base + '/api/mini-photo/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Referer: `https://servicewechat.com/${appId}/0/page-frame.html`,
        'Content-Type': 'application/json',
        'X-Chunmo-Mini-Proof': client?.proof ?? '',
        Cookie: client?.cookie ?? '',
        'X-CSRF-Token': client?.csrf ?? '',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function login(name: string, password: string) {
    const boot = await req('bootstrap', { code: 'test-code' });
    assert.equal(boot.status, 200);
    const c: Client = { proof: (await boot.json()).proof };
    const result = await req('login', { login: name, password }, c);
    assert.equal(result.status, 200);
    c.cookie = result.headers.get('set-cookie')!.split(';')[0];
    const session = await req('session', undefined, c);
    assert.equal(session.status, 200);
    const data = await session.json();
    c.csrf = data.csrf;
    return { c, user: data.user };
  }
  try {
    const a = await fixtureAccounts(),
      b = await fixtureAccounts();
    const first = await login(a.employee, a.password),
      other = await login(b.employee, b.password);
    const identity = await req('identity', undefined, first.c);
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).actorId, first.user.id);
    assert.equal(
      (
        await req(
          'nearby',
          { location: point, nearby: true, query: '', page: 1 },
          { ...first.c, csrf: 'wrong' },
        )
      ).status,
      403,
    );
    point.obtainedAt = new Date().toISOString();
    const found = await req(
      'nearby',
      { location: point, nearby: true, query: '', page: 1 },
      first.c,
    );
    assert.equal(found.status, 200);
    const receipt = (await found.json()).places[0].receipt;
    assert.equal(receipt.placeSource, 'amap-poi-selected');
    assert.equal(
      (
        await req(
          'renew',
          { location: point, previousToken: receipt.token, previousAt: receipt.resolvedAt },
          other.c,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          'renew',
          { location: point, previousToken: receipt.token, previousAt: receipt.resolvedAt },
          first.c,
        )
      ).status,
      200,
    );
    assert.equal((await req('workspace', { fixture: true }, first.c)).status, 404);
    await fixtureQuery('UPDATE account SET active=false WHERE id=$1', [other.user.id]);
    assert.equal((await req('identity', undefined, other.c)).status, 401);
    assert.equal((await req('logout', {}, first.c)).status, 200);
    assert.equal((await req('identity', undefined, first.c)).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    sidecar.closeAllConnections();
    old.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => sidecar.close(() => r())),
      new Promise<void>((r) => old.close(() => r())),
    ]);
    await Promise.all([legacy.pool.end(), legacy.privatePool.end(), pool.end(), privatePool.end()]);
  }
});
