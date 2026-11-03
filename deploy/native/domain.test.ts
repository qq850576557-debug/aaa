import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nginx, publicHTTPS } from './shared';
test('domain uses standard HTTPS, fixed-host HTTP redirect, same-origin API and streaming SSE', () => {
  const c = {
    origin: 'https://chmsj.cn',
    certificate: '/cert/fullchain.pem',
    key: '/cert/key.pem',
  };
  assert.equal(publicHTTPS(c).origin, c.origin);
  const text = nginx('/app', '/tls', '/state', 8443, 4000, c);
  assert.match(text, /listen 0\.0\.0\.0:443 ssl;/);
  assert.match(text, /listen 0\.0\.0\.0:80;/);
  assert.match(text, /return 308 https:\/\/chmsj\.cn\$request_uri;/);
  assert.match(text, /server_name chmsj\.cn;/);
  assert.match(text, /proxy_buffering off;/);
  assert.match(text, /listen 127\.0\.0\.1:8443 ssl;/);
  for (const origin of [
    'https://chmsj.cn:4000',
    'https://chmsj.cn/path',
    'http://chmsj.cn',
    'https://u:p@chmsj.cn',
  ])
    assert.throws(() => publicHTTPS({ ...c, origin }));
});
