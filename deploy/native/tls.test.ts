import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sign, createHash } from 'node:crypto';
import { createServer, get } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
const script = readFileSync('deploy/native/deploy.sh', 'utf8');
const functions = script
  .split('# BEGIN CHUNMO TLS FUNCTIONS')[1]
  .split('# END CHUNMO TLS FUNCTIONS')[0]
  .split('\n')
  .slice(1)
  .join('\n');
const root = mkdtempSync(join(tmpdir(), 'chunmo-tls-tests-'));
let baseline: string;
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function run(dir: string, mode = 'normal', extra = '', env: Record<string, string> = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      'set -Eeuo pipefail; umask 077; TLS=$1\n' +
        functions +
        '\n' +
        extra +
        '\ntls_manage_pair "$2"',
      'tls-test',
      dir,
      mode,
    ],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
}
function copy() {
  const p = mkdtempSync(join(root, 'case-'));
  cpSync(baseline, p, { recursive: true });
  return p;
}
function openssl(args: string[]) {
  return execFileSync('openssl', args, {
    env: { ...process.env, OPENSSL_CONF: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function pem(der: Buffer) {
  return (
    '-----BEGIN CERTIFICATE-----\n' +
    der
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n') +
    '\n-----END CERTIFICATE-----\n'
  );
}
function der(p: string) {
  return Buffer.from(readFileSync(p, 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
}
function tlv(tag: number, data: Buffer) {
  const n = data.length;
  const len =
    n < 128
      ? Buffer.from([n])
      : n < 256
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, data]);
}
function fields(data: Buffer) {
  const out: { tag: number; raw: Buffer; value: Buffer }[] = [];
  let i = 0;
  while (i < data.length) {
    const start = i,
      tag = data[i++];
    let n = data[i++];
    if (n & 128) {
      const count = n & 127;
      n = 0;
      for (let k = 0; k < count; k++) n = n * 256 + data[i++];
    }
    out.push({ tag, raw: data.subarray(start, i + n), value: data.subarray(i, i + n) });
    i += n;
  }
  return out;
}
function duplicateBasicConstraints(dir: string) {
  // Re-sign a real DER certificate with TWO Basic Constraints OIDs, reproducing
  // the invalid-root failure independently of OpenSSL's config dedup behavior.
  const top = fields(der(join(dir, 'ca.crt')))[0],
    outer = fields(top.value),
    tbs = fields(outer[0].value);
  const ext = tbs.find((x) => x.tag === 0xa3)!;
  const sequence = fields(ext.value)[0],
    items = fields(sequence.value);
  const bc = items.find((x) => fields(x.value)[0].raw.equals(Buffer.from('0603551d13', 'hex')))!;
  const bcFields = fields(bc.value);
  const withoutPath = tlv(
    0x30,
    Buffer.concat([
      ...bcFields.slice(0, -1).map((x) => x.raw),
      tlv(0x04, tlv(0x30, Buffer.from('0101ff', 'hex'))),
    ]),
  );
  const extended = tlv(
    0xa3,
    tlv(0x30, Buffer.concat([...items.map((x) => (x === bc ? withoutPath : x.raw)), bc.raw])),
  );
  const changed = tlv(0x30, Buffer.concat(tbs.map((x) => (x === ext ? extended : x.raw))));
  const signature = sign('sha256', changed, readFileSync(join(dir, 'ca.key')));
  const certificate = tlv(
    0x30,
    Buffer.concat([changed, outer[1].raw, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))]),
  );
  writeFileSync(join(dir, 'ca.crt'), pem(certificate));
}
before(() => {
  baseline = join(root, 'baseline');
  mkdirSync(baseline, { mode: 0o700 });
  const poison = join(root, 'poison.cnf');
  writeFileSync(poison, 'openssl_conf = broken\n[broken]\nunknown_module = missing\n');
  const r = run(baseline, 'normal', '', { OPENSSL_CONF: poison });
  assert.equal(r.status, 0, r.stderr);
  // Materialize legacy-layout fixtures; the deployment must upgrade existing
  // regular files, not just pass against its own new symlink layout.
  const legacy = join(root, 'legacy');
  mkdirSync(legacy, { mode: 0o700 });
  for (const name of ['ca.key', 'server.key', 'ca.crt', 'server.crt'])
    writeFileSync(join(legacy, name), readFileSync(join(baseline, name)), { mode: 0o600 });
  baseline = legacy;
});
test('controlled config ignores broken system defaults and generates unique extensions, valid CA/localhost/IP chain and matching keys', () => {
  const dir = copy(),
    r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['ca', 'server']) {
    const text = openssl(['x509', '-in', join(dir, name + '.crt'), '-text', '-noout']).toString();
    assert.equal((text.match(/X509v3 Basic Constraints:/g) || []).length, 1);
  }
  for (const args of [
    ['-verify_hostname', 'localhost'],
    ['-verify_ip', '127.0.0.1'],
  ])
    openssl([
      'verify',
      '-x509_strict',
      '-purpose',
      'sslserver',
      '-CAfile',
      join(dir, 'ca.crt'),
      ...args,
      join(dir, 'server.crt'),
    ]);
  openssl(['x509', '-checkend', '1209600', '-noout', '-in', join(dir, 'server.crt')]);
});
test('duplicate root is rejected normally, repair retains both keys, backs up originals and atomically selects a validated pair', () => {
  const dir = copy();
  duplicateBasicConstraints(dir);
  const names = ['ca.key', 'server.key', 'ca.crt', 'server.crt'],
    before = names.map((n) => hash(join(dir, n)));
  const rejected = spawnSync(
    'openssl',
    [
      'verify',
      '-CAfile',
      join(dir, 'ca.crt'),
      '-verify_hostname',
      'localhost',
      join(dir, 'server.crt'),
    ],
    { env: { ...process.env, OPENSSL_CONF: '/dev/null' }, encoding: 'utf8' },
  );
  assert.notEqual(
    rejected.status,
    0,
    'the reproduced root must actually fail OpenSSL chain verification',
  );
  const bad = run(dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /duplicate certificate extensions/);
  assert.deepEqual(
    names.map((n) => hash(join(dir, n))),
    before,
  );
  const fixed = run(dir, 'repair');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(
    names.slice(0, 2).map((n) => hash(join(dir, n))),
    before.slice(0, 2),
  );
  const backup = join(
    dir,
    readdirSync(dir).find((n) => n.startsWith('backup-'))!,
  );
  assert.deepEqual(
    names.map((n) => hash(join(backup, n))),
    before,
  );
  assert.equal(statSync(backup).mode & 0o777, 0o700);
  assert.equal(readlinkSync(join(dir, 'ca.crt')), '.certificates/current/ca.crt');
  assert.equal(readlinkSync(join(dir, 'server.crt')), '.certificates/current/server.crt');
  assert.match(readlinkSync(join(dir, '.certificates/current')), /^cert-/);
  assert.equal(run(dir).status, 0);
  const fingerprint = hash(join(dir, 'ca.crt'));
  assert.equal(run(dir, 'repair').status, 0);
  assert.equal(hash(join(dir, 'ca.crt')), fingerprint);
});
test('candidate chain verification failure never replaces original certificates, keys or active bundle', () => {
  const dir = copy();
  duplicateBasicConstraints(dir);
  assert.equal(run(dir, 'repair').status, 0);
  const active = readlinkSync(join(dir, '.certificates/current'));
  const names = ['ca.key', 'server.key', 'ca.crt', 'server.crt'],
    before = names.map((n) => hash(join(dir, n)));
  const real = resolve(
    execFileSync('bash', ['-c', 'command -v openssl'], { encoding: 'utf8' }).trim(),
  );
  const deny = `openssl() { if [[ $1 == verify ]]; then return 77; fi; command ${real} "$@"; }`;
  const r = run(dir, 'repair', deny);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Candidate TLS validation failed/);
  assert.deepEqual(
    names.map((n) => hash(join(dir, n))),
    before,
  );
  assert.equal(readlinkSync(join(dir, '.certificates/current')), active);
});
test('an unrelated existing private key is refused without overwriting the original certificates', () => {
  const dir = copy();
  const before = hash(join(dir, 'server.crt'));
  writeFileSync(join(dir, 'server.key'), readFileSync(join(dir, 'ca.key')));
  const r = run(dir, 'repair');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /private-key mismatch/);
  assert.equal(hash(join(dir, 'server.crt')), before);
});
test('missing SAN and near-expiry leaf are rejected; original keys can safely reissue valid certificates', () => {
  for (const days of ['365', '1']) {
    const dir = copy(),
      ext = join(dir, 'invalid.ext');
    writeFileSync(
      ext,
      '[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' +
        (days === '1' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : ''),
    );
    openssl([
      'req',
      '-new',
      '-key',
      join(dir, 'server.key'),
      '-subj',
      '/CN=localhost',
      '-config',
      '/dev/null',
      '-out',
      join(dir, 'request.csr'),
    ]);
    openssl([
      'x509',
      '-req',
      '-in',
      join(dir, 'request.csr'),
      '-CA',
      join(dir, 'ca.crt'),
      '-CAkey',
      join(dir, 'ca.key'),
      '-set_serial',
      '12345',
      '-days',
      days,
      '-extfile',
      ext,
      '-extensions',
      'leaf',
      '-out',
      join(dir, 'server.crt'),
    ]);
    assert.notEqual(run(dir).status, 0);
    assert.equal(run(dir, 'repair').status, 0);
  }
});
test('certificate-only mode is dispatched before PostgreSQL, build or normal deployment hooks', () => {
  const branch = script.slice(
    script.indexOf('# Explicit certificate-only repair:'),
    script.indexOf("trap 'on_error"),
  );
  assert.ok(branch.includes('--repair-tls'));
  assert.ok(branch.includes('exit 0'));
  assert.ok(!/\b(sql|psql|runuser|npm|systemctl)\b/.test(branch));
  assert.ok(
    script.indexOf('# Explicit certificate-only repair:') <
      script.indexOf('source /etc/os-release'),
  );
});

test('repaired certificates complete a real HTTPS handshake with CA and hostname verification enabled', async () => {
  const dir = copy();
  duplicateBasicConstraints(dir);
  const r = run(dir, 'repair');
  assert.equal(r.status, 0, r.stderr);
  const server = createServer(
    { key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) },
    (_req, res) => res.end('verified'),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await new Promise<void>((done, fail) => {
      const req = get(
        {
          hostname: '127.0.0.1',
          port: (server.address() as AddressInfo).port,
          servername: 'localhost',
          ca: readFileSync(join(dir, 'ca.crt')),
          rejectUnauthorized: true,
        },
        (res) => {
          const authorized = (res.socket as TLSSocket).authorized;
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              assert.equal(body, 'verified');
              assert.equal(authorized, true);
              done();
            } catch (e) {
              fail(e);
            }
          });
        },
      );
      req.on('error', fail);
      req.setTimeout(5000, () => req.destroy(Error('HTTPS test timeout')));
    });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
