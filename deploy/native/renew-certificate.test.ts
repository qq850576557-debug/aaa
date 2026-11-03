import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const mode of [
  'unchanged',
  'changed',
  'activation-fails',
  'renew-fails',
  'validation-fails',
]) {
  test(`certificate renewal: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-renew-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const base = join(root, 'base');
    mkdirSync(join(base, 'current/deploy/native'), { recursive: true });
    const executable = (name: string, body: string) =>
      writeFileSync(join(bin, name), '#!/bin/bash\nset -e\n' + body, { mode: 0o700 });
    executable(
      'certbot',
      `echo "$*" >> "$LOG"\nexit ${['renew-fails', 'validation-fails'].includes(mode) ? 1 : 0}\n`,
    );
    executable(
      'python3',
      'if [[ $* == *certificate* ]]; then echo /test-active.pem; else echo https://chmsj.cn; fi\n',
    );
    executable(
      'openssl',
      `if [[ $3 == /test-active.pem ]]; then echo old; else echo ${mode === 'unchanged' ? 'old' : 'new'}; fi\n`,
    );
    writeFileSync(
      join(base, 'current/deploy/native/public-https.sh'),
      `echo activate >> "$LOG"\nexit ${mode === 'activation-fails' ? 1 : 0}\n`,
    );
    const script = readFileSync('deploy/native/renew-certificate.sh', 'utf8')
      .replace('[[ $EUID == 0 ]]', 'true')
      .replace('CERTBOT=/root/chunmo-acme-venv/bin/certbot', `CERTBOT=${join(bin, 'certbot')}`)
      .replace('BASE=/opt/chunmo-staging', `BASE=${base}`)
      .replace('/run/lock/chunmo-certificate-renew.lock', join(root, 'lock'));
    const result = spawnSync(
      'bash',
      ['-c', script, '_', ...(mode === 'validation-fails' ? ['--install'] : [])],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: join(root, 'log') },
      },
    );
    assert.equal(result.status, ['unchanged', 'changed'].includes(mode) ? 0 : 1, result.stderr);
    const log = readFileSync(join(root, 'log'), 'utf8');
    assert.equal(log.includes('activate'), ['changed', 'activation-fails'].includes(mode));
    assert.ok(log.includes('--webroot-path /var/lib/chunmo-acme'));
    assert.equal(existsSync(join(base, 'renew-certificate.sh')), false);
  });
}
