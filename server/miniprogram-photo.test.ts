import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMiniPhotoGateway, miniPhotoRoutes } from './miniprogram-photo';

const appId = 'wx1234567890abcdef';
const referer = `https://servicewechat.com/${appId}/0/page-frame.html`;
async function fixture(extra: Record<string, unknown> = {}) {
  let now = 1800000000000;
  const app = express();
  app.use(
    createMiniPhotoGateway({
      enabled: true,
      appId,
      appSecret: 'test-only',
      signingKey: 'test-only-key-'.repeat(4),
      origin: 'https://studio.example',
      now: () => now,
      exchange: async (code) =>
        code === 'valid-one-use-code' ? { openid: 'test-wx' } : { errcode: 40029 },
      ...extra,
    }),
  );
  app.use(express.json());
  app.use((req, res) => {
    // Exact original Origin, account cookie and CSRF checks remain downstream.
    if (
      req.path !== '/api/auth/login' &&
      (!req.get('cookie') || (req.method === 'POST' && req.get('X-CSRF-Token') !== 'test-csrf'))
    )
      return res.status(403).json({ error: 'account/CSRF required' });
    if (req.get('origin') !== 'https://studio.example')
      return res.status(403).json({ error: 'origin required' });
    return res.json({ path: req.path, body: req.body, csrf: req.get('X-CSRF-Token') });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const send = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method?: string,
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { referer, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    send,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    advance: () => {
      now += 600001;
    },
  };
}
async function proof(f: Awaited<ReturnType<typeof fixture>>) {
  const r = await f.send('/api/mini-photo/bootstrap', { code: 'valid-one-use-code' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const data = await r.json();
  assert.ok(data.proof);
  assert.equal(data.openid, undefined);
  assert.equal(data.session_key, undefined);
  return data.proof as string;
}
test('gateway defaults can be disabled without changing normal website requests', async () => {
  const f = await fixture({ enabled: false });
  try {
    assert.equal((await f.send('/api/mini-photo/bootstrap', { code: 'x' })).status, 404);
    const normal = await f.send('/api/auth/login', {}, { origin: 'https://studio.example' });
    assert.equal(normal.status, 200);
    assert.equal((await normal.json()).path, '/api/auth/login');
  } finally {
    await f.close();
  }
});
test('real code exchange and configured WeChat referer required; foreign Origin refused', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('/api/mini-photo/bootstrap', { code: 'bad' })).status, 401);
    assert.equal(
      (
        await f.send(
          '/api/mini-photo/bootstrap',
          { code: 'valid-one-use-code' },
          { origin: 'https://evil.example' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.send(
          '/api/mini-photo/bootstrap',
          { code: 'valid-one-use-code' },
          { referer: 'https://servicewechat.com/foreign/0/x' },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.send('/api/mini-photo/bootstrap', { code: 'valid-one-use-code', actorId: 'spoof' }))
        .status,
      400,
    );
    await proof(f);
  } finally {
    await f.close();
  }
});
test('proof forgery, expiry and missing proof cannot reach original handlers', async () => {
  const f = await fixture();
  try {
    const token = await proof(f);
    for (const value of ['', token + 'x', 'malformed', token + '.extra'])
      assert.equal(
        (await f.send('/api/mini-photo/login', {}, { 'X-Chunmo-Mini-Proof': value })).status,
        401,
      );
    f.advance();
    const expired = await f.send('/api/mini-photo/login', {}, { 'X-Chunmo-Mini-Proof': token });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).code, 'MINI_PROOF_EXPIRED');
  } finally {
    await f.close();
  }
});
test('only six allowlisted paths; original account cookie/CSRF still mandatory', async () => {
  const f = await fixture();
  try {
    const token = await proof(f),
      h = { 'X-Chunmo-Mini-Proof': token };
    for (const path of ['/workspace', '/site-photos', '/auth/profile', '/nearby?other=1'])
      assert.equal((await f.send('/api/mini-photo' + path, {}, h)).status, 404);
    assert.equal((await f.send('/api/mini-photo/nearby', {}, h)).status, 403);
    assert.equal(
      (await f.send('/api/mini-photo/nearby', {}, { ...h, cookie: 'test-cookie' })).status,
      403,
    );
    for (const [key, destination] of Object.entries(miniPhotoRoutes)) {
      const [method, path] = key.split(' ');
      const r = await f.send(
        '/api/mini-photo' + path,
        method === 'POST' ? { fixture: true } : undefined,
        { ...h, cookie: 'test-cookie', 'X-CSRF-Token': 'test-csrf' },
        method,
      );
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.path, destination);
      if (method === 'POST') assert.deepEqual(body.body, { fixture: true });
    }
  } finally {
    await f.close();
  }
});
test('bootstrap rate limit rejects repeated exchange attempts', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++)
      assert.equal((await f.send('/api/mini-photo/bootstrap', { code: 'bad' })).status, 401);
    assert.equal((await f.send('/api/mini-photo/bootstrap', { code: 'bad' })).status, 429);
  } finally {
    await f.close();
  }
});

test('workbench is explicitly opt-in and cannot proxy project, admin or snapshot mutations', async () => {
  const off = await fixture();
  try {
    assert.equal((await off.send('/api/mini-photo/workbench/workspace')).status, 404);
  } finally {
    await off.close();
  }
  const on = await fixture({ workbenchEnabled: true });
  try {
    const h = {
      'X-Chunmo-Mini-Proof': await proof(on),
      Cookie: 'chunmo_session=test',
      'X-CSRF-Token': 'test-csrf',
    };
    assert.equal((await on.send('/api/mini-photo/workbench/workspace', undefined, h)).status, 200);
    assert.equal((await on.send('/api/mini-photo/workbench/accounts', undefined, h)).status, 404);
    assert.equal(
      (await on.send('/api/mini-photo/workbench/workspace', { revision: 0, data: {} }, h, 'PUT'))
        .status,
      400,
    );
    assert.equal(
      (
        await on.send(
          '/api/mini-photo/workbench/workspace',
          { protocol: 3, changes: [{ collection: 'projects', kind: 'record', after: {} }] },
          h,
          'PUT',
        )
      ).status,
      400,
    );
  } finally {
    await on.close();
  }
});
