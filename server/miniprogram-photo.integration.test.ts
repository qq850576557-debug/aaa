import { test, after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { config } from './config';
import { pool, privatePool } from './db';
import { fixtureAccounts } from './test-fixtures';
import { wgsToGcj } from '../src/lib/photo-location';

let server: Server, base: string;
const appid = 'wx1234567890abcdef';
const point = {
  latitude: 30.286,
  longitude: 120.123,
  accuracy: 18,
  obtainedAt: new Date().toISOString(),
};
const originalFetch = globalThis.fetch;
const oldEnvironment = {
  enabled: process.env.CHUNMO_MINI_PHOTO_ENABLED,
  appid: process.env.CHUNMO_MINI_APP_ID,
  secret: process.env.CHUNMO_MINI_APP_SECRET,
  amap: process.env.CHUNMO_AMAP_ENABLED,
  key: process.env.CHUNMO_AMAP_KEY,
};
before(async () => {
  if (config.APP_ENV !== 'test') throw Error('Only dedicated local _test databases permitted');
  process.env.CHUNMO_MINI_PHOTO_ENABLED = '1';
  process.env.CHUNMO_MINI_APP_ID = appid;
  process.env.CHUNMO_MINI_APP_SECRET = 'synthetic-test-only';
  process.env.CHUNMO_AMAP_ENABLED = '1';
  process.env.CHUNMO_AMAP_KEY = 'synthetic-test-only';
  mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).startsWith('https://api.weixin.qq.com/sns/jscode2session')) {
        const valid = new URL(String(url)).searchParams.get('js_code') === 'test-code';
        return Response.json(
          valid ? { openid: 'synthetic-wx', session_key: 'must-never-return' } : { errcode: 40029 },
        );
      }
      if (String(url).startsWith('https://restapi.amap.com/v3/place/around')) {
        const p = wgsToGcj(point.latitude, point.longitude);
        return Response.json({
          status: '1',
          count: '1',
          pois: [
            {
              id: 'test-poi',
              name: '隔离测试地点',
              address: '测试地址',
              location: `${p.longitude},${p.latitude}`,
            },
          ],
        });
      }
      return originalFetch(url, init);
    },
  );
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  mock.restoreAll();
  for (const [key, value] of Object.entries({
    CHUNMO_MINI_PHOTO_ENABLED: oldEnvironment.enabled,
    CHUNMO_MINI_APP_ID: oldEnvironment.appid,
    CHUNMO_MINI_APP_SECRET: oldEnvironment.secret,
    CHUNMO_AMAP_ENABLED: oldEnvironment.amap,
    CHUNMO_AMAP_KEY: oldEnvironment.key,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await pool.end();
  await privatePool.end();
});
type Client = { proof: string; cookie?: string; csrf?: string };
function request(
  path: string,
  body?: unknown,
  client?: Client,
  extra: Record<string, string> = {},
) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Referer: `https://servicewechat.com/${appid}/0/page-frame.html`,
      'Content-Type': 'application/json',
      ...(client
        ? {
            'X-Chunmo-Mini-Proof': client.proof,
            Cookie: client.cookie ?? '',
            'X-CSRF-Token': client.csrf ?? '',
          }
        : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function client(login: string, password: string) {
  const boot = await request('/api/mini-photo/bootstrap', { code: 'test-code' });
  assert.equal(boot.status, 200);
  const b = await boot.json();
  assert.equal(b.session_key, undefined);
  assert.equal(b.openid, undefined);
  const c: Client = { proof: b.proof };
  const result = await request('/api/mini-photo/login', { login, password }, c);
  assert.equal(result.status, 200);
  c.cookie = result.headers.get('set-cookie')!.split(';')[0];
  const session = await request('/api/mini-photo/session', undefined, c);
  assert.equal(session.status, 200);
  const s = await session.json();
  c.csrf = s.csrf;
  return { c, user: s.user };
}
test('real employee login/session/CSRF, server identity, signed POI, cross-account denial and unchanged web gate', async () => {
  const f = await fixtureAccounts(),
    other = await fixtureAccounts();
  const { c, user } = await client(f.employee, f.password),
    { c: stranger } = await client(other.employee, other.password);
  const identity = await request('/api/mini-photo/identity', undefined, c);
  assert.equal(identity.status, 200);
  const i = await identity.json();
  assert.equal(i.actorId, user.id);
  assert.ok(i.actorName);
  const wrong = await request(
    '/api/mini-photo/login',
    { login: f.employee, password: 'wrong-password-test' },
    { proof: c.proof },
  );
  assert.equal(wrong.status, 401);
  assert.equal(
    (
      await request(
        '/api/mini-photo/nearby',
        { location: point, nearby: true, query: '', page: 1 },
        { ...c, csrf: 'bad' },
      )
    ).status,
    403,
  );
  point.obtainedAt = new Date().toISOString();
  const nearby = await request(
    '/api/mini-photo/nearby',
    { location: point, nearby: true, query: '', page: 1 },
    c,
  );
  assert.equal(nearby.status, 200);
  const p = (await nearby.json()).places[0].receipt;
  assert.ok(p.token);
  assert.equal(p.placeSource, 'amap-poi-selected');
  assert.equal(
    (
      await request(
        '/api/mini-photo/renew',
        { location: point, previousToken: p.token, previousAt: p.resolvedAt },
        stranger,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/api/mini-photo/renew',
        { location: point, previousToken: p.token, previousAt: p.resolvedAt },
        c,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        '/api/mini-photo/nearby',
        { location: point, nearby: true, query: '', page: 1, actorId: 'spoof' },
        c,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/api/auth/login', { login: f.employee, password: f.password }, undefined, {
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  // Existing browser flow still works with the exact original trusted Origin.
  assert.equal(
    (
      await request('/api/auth/login', { login: f.login, password: f.password }, undefined, {
        Origin: config.APP_ORIGIN,
      })
    ).status,
    200,
  );
  const old = { ...c };
  assert.equal((await request('/api/mini-photo/logout', {}, c)).status, 200);
  assert.equal((await request('/api/mini-photo/identity', undefined, old)).status, 401);
});
