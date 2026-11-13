import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiniPhotoSidecar } from './miniprogram-sidecar';
test('sidecar requires wx proof and forwards only existing allowed API with original CSRF/cookie', async () => {
  let calls = 0;
  const old = http.createServer((req, res) => {
    calls++;
    assert.equal(req.url, '/api/auth/logout');
    assert.equal(req.headers.cookie, 'fixture-cookie');
    assert.equal(req.headers['x-csrf-token'], 'fixture-csrf');
    assert.equal(req.headers.origin, 'https://studio.example');
    res.setHeader('Set-Cookie', 'fixture=ok');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
  const appId = 'wx1234567890abcdef';
  const server = createMiniPhotoSidecar({
    enabled: true,
    appId,
    appSecret: 'synthetic',
    signingKey: 'test-only'.repeat(8),
    origin: 'https://studio.example',
    apiPort: (old.address() as { port: number }).port,
    exchange: async () => ({ openid: 'synthetic' }),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const headers = {
    referer: `https://servicewechat.com/${appId}/0/page-frame.html`,
    'content-type': 'application/json',
  };
  try {
    assert.equal(
      (await fetch(base + '/api/auth/logout', { method: 'POST', headers, body: '{}' })).status,
      404,
    );
    assert.equal(
      (await fetch(base + '/api/mini-photo/logout', { method: 'POST', headers, body: '{}' }))
        .status,
      401,
    );
    assert.equal(calls, 0);
    const boot = await (
      await fetch(base + '/api/mini-photo/bootstrap', {
        method: 'POST',
        headers,
        body: '{"code":"test"}',
      })
    ).json();
    const result = await fetch(base + '/api/mini-photo/logout', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Chunmo-Mini-Proof': boot.proof,
        Cookie: 'fixture-cookie',
        'X-CSRF-Token': 'fixture-csrf',
      },
      body: '{}',
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).ok, true);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    old.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => old.close(() => r())),
    ]);
  }
});
