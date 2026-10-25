import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { nginx, publicHTTPS } from './shared';
import { validateCertificate, preparePublic } from './public';

test('public entry opt-in keeps internal HTTPS and loopback API; no HTTP or SSE buffering', () => {
  const external = {
    origin: 'https://39.105.64.188:15001',
    certificate: '/tls/public/fullchain.pem',
    key: '/tls/public/server.key',
  };
  const rendered = nginx('/app', '/tls', '/state', 8443, 4000, external);
  assert.match(rendered, /listen 127\.0\.0\.1:8443 ssl;/);
  assert.match(rendered, /listen 0\.0\.0\.0:15001 ssl;/);
  assert.equal((rendered.match(/proxy_pass http:\/\/127\.0\.0\.1:4000/g) ?? []).length, 2);
  assert.equal((rendered.match(/proxy_buffering off/g) ?? []).length, 2);
  assert.match(rendered, /ssl_certificate \/tls\/public\/fullchain.pem;/);
  assert.match(rendered, /if \(\$host != "39\.105\.64\.188"\) \{ return 421; \}/);
  assert.ok(!nginx('/app', '/tls', '/state').includes('15001'));
  for (const origin of [
    'http://39.105.64.188:15001',
    'https://39.105.64.188',
    'https://user:pass@39.105.64.188:15001',
    'https://39.105.64.188:15001/path',
  ])
    assert.throws(() => publicHTTPS({ ...external, origin }));
  assert.throws(() => publicHTTPS({ ...external, certificate: '/tls/cert;injected' }));
});

test('public TLS requires system trust, correct IP SAN, matching key and sufficient validity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chunmo-public-test-'));
  const file = (name: string) => join(dir, name);
  writeFileSync(
    file('openssl.cnf'),
    `[req]
prompt=no
distinguished_name=dn
[dn]
CN=Public HTTPS isolated test CA
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:39.105.64.188
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
`,
  );
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, {
      stdio: 'pipe',
      env: { ...process.env, OPENSSL_CONF: file('openssl.cnf') },
    });
  openssl(
    'req',
    '-new',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '4',
    '-extensions',
    'ca',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.pem'),
  );
  openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('server.key'),
    '-out',
    file('server.csr'),
  );
  const issue = (name: string, days: string) =>
    openssl(
      'x509',
      '-req',
      '-in',
      file('server.csr'),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca.key'),
      '-set_serial',
      '2',
      '-days',
      days,
      '-extfile',
      file('openssl.cnf'),
      '-extensions',
      'leaf',
      '-out',
      file(name),
    );
  issue('server.pem', '3');
  writeFileSync(
    file('fullchain.pem'),
    readFileSync(file('server.pem'), 'utf8') + readFileSync(file('ca.pem'), 'utf8'),
  );
  const origin = 'https://39.105.64.188:15001';
  // Synthetic CA is explicitly trusted only by this test, never by the deployment CLI.
  assert.ok(validateCertificate(origin, file('fullchain.pem'), file('server.key'), file('ca.pem')));
  assert.throws(() => validateCertificate(origin, file('fullchain.pem'), file('server.key')));
  assert.throws(() =>
    validateCertificate(
      'https://39.105.64.189:15001',
      file('fullchain.pem'),
      file('server.key'),
      file('ca.pem'),
    ),
  );
  assert.throws(() =>
    validateCertificate(origin, file('fullchain.pem'), file('ca.key'), file('ca.pem')),
  );
  issue('short.pem', '1');
  assert.throws(
    () => validateCertificate(origin, file('short.pem'), file('server.key'), file('ca.pem')),
    /24 hours/,
  );
  // Rejected input leaves configuration byte-identical and never creates deployment files.
  const before = readFileSync(file('server.key'));
  assert.throws(() =>
    preparePublic(dir, dir, '/app', '/state', origin, file('fullchain.pem'), file('server.key')),
  );
  assert.deepEqual(readFileSync(file('server.key')), before);
});

test('public activation validates before replacement, backs up, rolls back and never opens firewall/DB', () => {
  const script = readFileSync('deploy/native/public-https.sh', 'utf8');
  assert.ok(script.indexOf('nginx.conf"') < script.indexOf('ACTIVATED=1'));
  assert.match(script, /trap rollback ERR/);
  assert.match(script, /cp -p.*runtime.env/);
  assert.match(script, /--resolve/);
  assert.ok(
    !/curl[^\n]*\s-k\b|firewall-cmd|iptables|psql|initdb|rejectUnauthorized:\s*false/.test(script),
  );
  assert.match(script, /flock -n 9/);
});

for (const fail of [false, true])
  test(`activation shell ${fail ? 'rolls back failed smoke' : 'retains successful config'} without touching services outside the harness`, () => {
    const root = mkdtempSync(join(tmpdir(), 'chunmo-public-shell-'));
    const base = join(root, 'base'),
      conf = join(root, 'conf'),
      tls = join(root, 'tls'),
      bin = join(root, 'bin'),
      release = join(root, 'release');
    for (const path of [base, conf, tls, bin, release, join(release, 'dist-deploy')])
      mkdirSync(path, { recursive: true });
    symlinkSync(release, join(base, 'current'));
    writeFileSync(join(release, '.verified-build'), 'test');
    writeFileSync(join(release, 'dist-deploy/public.mjs'), 'test');
    const bundle = join(tls, 'public-synthetic');
    mkdirSync(bundle);
    for (const [file, content] of Object.entries({
      'runtime.env': 'APP_ORIGIN=https://39.105.64.188:15001\n',
      'nginx.conf': 'new nginx',
      'public-https.json': '{"origin":"public"}',
      'fullchain.pem': 'test',
      'server.key': 'test',
    }))
      writeFileSync(join(bundle, file), content);
    const oldEnv = 'APP_ORIGIN=https://localhost:8443\nPRIVATE_DATA_KEY=unchanged-test-key\n';
    writeFileSync(join(conf, 'runtime.env'), oldEnv);
    writeFileSync(join(base, 'nginx.conf'), 'original nginx');
    const executable = (name: string, body: string) =>
      writeFileSync(join(bin, name), '#!/bin/bash\nset -e\n' + body + '\n', { mode: 0o700 });
    executable(
      'fake-node',
      'if [[ $1 == */public.mjs ]]; then echo "$TEST_BUNDLE"; elif [[ $2 == smoke && $TEST_FAIL == 1 ]]; then exit 1; fi',
    );
    executable('systemctl', 'echo "$*" >> "$TEST_LOG"');
    executable('nginx', 'exit 0');
    executable('runuser', 'shift 3; exec "$@"');
    executable('curl', `echo '{"ok":true}'`);
    executable('sleep', 'exit 0');
    executable('chgrp', 'exit 0');
    writeFileSync(join(conf, 'tools.env'), `NODE_BIN=${join(bin, 'fake-node')}\n`);
    const script = readFileSync('deploy/native/public-https.sh', 'utf8')
      .replace('[[ $EUID == 0 && $# == 3 ]]', '[[ $# == 3 ]]')
      .replace('BASE=/opt/chunmo-staging', `BASE=${base}`)
      .replace('CONF=/etc/chunmo-staging', `CONF=${conf}`)
      .replace('TLS=/etc/pki/chunmo-staging', `TLS=${tls}`)
      .replace('/run/lock/chunmo-staging-deploy.lock', join(root, 'deploy.lock'));
    const result = spawnSync(
      'bash',
      ['-c', script, 'test', 'https://39.105.64.188:15001', '/test/cert', '/test/key'],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          TEST_BUNDLE: bundle,
          TEST_FAIL: fail ? '1' : '0',
          TEST_LOG: join(root, 'calls'),
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const backup = join(
      conf,
      readdirSync(conf).find((name) => name.startsWith('public-before.'))!,
    );
    assert.equal(readFileSync(join(backup, 'runtime.env'), 'utf8'), oldEnv);
    assert.equal(
      readFileSync(join(conf, 'runtime.env'), 'utf8'),
      fail ? oldEnv : readFileSync(join(bundle, 'runtime.env'), 'utf8'),
    );
    assert.equal(
      readFileSync(join(base, 'nginx.conf'), 'utf8'),
      fail ? 'original nginx' : 'new nginx',
    );
    assert.equal(existsSync(join(conf, 'public-https.json')), !fail);
    assert.ok(!result.stdout.includes('unchanged-test-key'));
  });
