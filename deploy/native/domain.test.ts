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
  assert.match(text, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.match(text, /root \/var\/lib\/chunmo-acme;/);
  assert.match(text, /try_files \$uri =404;/);
  assert.match(text, /return 308 https:\/\/chmsj\.cn\$request_uri;/);
  assert.match(text, /server_name chmsj\.cn;/);
  assert.match(text, /proxy_buffering off;/);
  assert.match(text, /listen 127\.0\.0\.1:8443 ssl;/);
  assert.equal(text.split('include /etc/chunmo-staging/downloads/*.conf;').length - 1, 2);
  assert.equal(text.split('include /var/lib/chunmo-downloads/routes/*.conf;').length - 1, 2);
  assert.equal(text.split('include /opt/chunmo-mini-photo/routes/*.conf;').length - 1, 2);
  for (const origin of [
    'https://chmsj.cn:4000',
    'https://chmsj.cn/path',
    'http://chmsj.cn',
    'https://u:p@chmsj.cn',
  ])
    assert.throws(() => publicHTTPS({ ...c, origin }));
});

test('rendered units grant low-port binding only to the dedicated web account', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const out = mkdtempSync(join(tmpdir(), 'cm-lowport-'));
  execFileSync(
    'python3',
    ['deploy/native/render-units.py', '/usr/bin/node', '/usr/sbin/nginx', 'postgresql.service'],
    { env: { ...process.env, CHUNMO_UNIT_TEST_OUTPUT: out } },
  );
  const web = readFileSync(join(out, 'chunmo-staging-web.service'), 'utf8');
  const api = readFileSync(join(out, 'chunmo-staging-api.service'), 'utf8');
  assert.match(web, /^User=chunmo-staging-web$/m);
  assert.match(web, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m);
  assert.match(web, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
  assert.match(web, /^NoNewPrivileges=yes$/m);
  assert.match(api, /^CapabilityBoundingSet=$/m);
  assert.ok(!api.includes('AmbientCapabilities='));
});
