import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  newDeployment,
  validate,
  identifier,
  initConfig,
  hba,
  encrypt,
  decrypt,
  nginx,
} from './shared';
test('repeat configuration preserves every credential and key; partial config never regenerates', () => {
  const parent = mkdtempSync(join(tmpdir(), 'chunmo-config-check-')),
    path = join(parent, 'private');
  initConfig(path);
  const before = ['control.json', 'runtime.env', 'backup.key', 'owner.env'].map((x) =>
    readFileSync(join(path, x), 'utf8'),
  );
  initConfig(path);
  assert.deepEqual(
    before,
    ['control.json', 'runtime.env', 'backup.key', 'owner.env'].map((x) =>
      readFileSync(join(path, x), 'utf8'),
    ),
  );
  assert.equal(statSync(join(path, 'runtime.env')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(path, 'runtime.env'), 'utf8').includes('cm_stg_migrator'));
  unlinkSync(join(path, 'backup.key'));
  assert.throws(() => initConfig(path), /Partial config/);
  assert.equal(readFileSync(join(path, 'runtime.env'), 'utf8'), before[1]);
});
test('only managed database HBA is prepended and existing cluster policy stays byte-for-byte', () => {
  const old = '# original cluster\nlocal all all peer\nhost all all 127.0.0.1/32 trust\n';
  const next = hba(old, 'chunmo_staging');
  assert.ok(next.endsWith(old));
  assert.ok(next.startsWith('# BEGIN CHUNMO'));
  assert.equal(hba(next, 'chunmo_staging'), next);
  assert.throws(() => hba(next.replace('scram-sha-256', 'trust'), 'chunmo_staging'), /changed/);
  assert.throws(() => hba(old, 'postgres;DROP DATABASE'), /Invalid/);
});
test('backup encryption authenticates data, header and key and refuses truncation', () => {
  const key = randomBytes(32),
    data = Buffer.from('private backup synthetic data'),
    sealed = encrypt(data, key);
  assert.deepEqual(decrypt(sealed, key), data);
  assert.ok(!sealed.includes(data));
  const changed = Buffer.from(sealed);
  changed[changed.length - 17] ^= 1;
  assert.throws(() => decrypt(changed, key));
  assert.throws(() => decrypt(sealed, randomBytes(32)));
  assert.throws(() => decrypt(sealed.subarray(0, 16), key));
});
test('private HTTPS config keeps API same-origin, SSE streaming and no public listeners', () => {
  const conf = nginx(
    '/opt/chunmo-staging/current',
    '/etc/pki/chunmo-staging',
    '/var/lib/chunmo-staging-web',
  );
  assert.match(conf, /listen 127\.0\.0\.1:8443 ssl;/);
  assert.ok(!conf.includes('listen 80'));
  assert.match(conf, /proxy_buffering off/);
  assert.match(conf, /proxy_set_header Host \$http_host/);
  assert.match(conf, /access_log off/);
  assert.throws(() => nginx('/tmp/unsafe;', '/tls', '/state'));
  assert.throws(() => nginx('/root', '/tls', '/state', 80));
});
test('configuration refuses privilege-role conflation and external database hosts', () => {
  const c = newDeployment();
  assert.equal(validate(c), c);
  assert.throws(() => identifier('postgres";'));
  assert.throws(() => validate({ ...c, host: '0.0.0.0' }));
  assert.throws(() => validate({ ...c, roles: { ...c.roles, private: c.roles.app } }));
});
