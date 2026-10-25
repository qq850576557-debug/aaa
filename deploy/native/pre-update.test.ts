import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
for (const fail of [false, true])
  test(`pre-update ${fail ? 'stops before archiving on DB backup failure' : 'backs up DB before immutable release/config snapshot'}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'chunmo-v11-before-'));
    const base = join(root, 'base'),
      conf = join(root, 'conf'),
      backups = join(root, 'backups'),
      bin = join(root, 'bin'),
      release = join(base, 'releases', 'original');
    for (const dir of [base, conf, backups, bin, release]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(release, '.verified-build'), 'baseline');
    symlinkSync(release, join(base, 'current'));
    writeFileSync(join(base, 'nginx.conf'), 'unchanged private/public config');
    const executable = (name: string, text: string) =>
      writeFileSync(join(bin, name), '#!/bin/bash\nset -e\n' + text + '\n', { mode: 0o700 });
    executable('backup-node', 'echo backup >> "$CHECK_LOG"; [[ "$CHECK_FAIL" != 1 ]]');
    executable(
      'tar',
      'echo archive >> "$CHECK_LOG"; [[ $1 == -czf ]]; echo synthetic-archive > "$2"',
    );
    writeFileSync(
      join(conf, 'tools.env'),
      `NODE_BIN=${join(bin, 'backup-node')}\nPG_DUMP_BIN=/test/pg_dump\n`,
    );
    const code = readFileSync('deploy/native/pre-update.sh', 'utf8')
      .replace('[[ $EUID == 0 ]]', '[[ 1 == 1 ]]')
      .replace('BASE=/opt/chunmo-staging', `BASE=${base}`)
      .replace('CONF=/etc/chunmo-staging', `CONF=${conf}`)
      .replace('BACKUPS=/var/backups/chunmo-staging', `BACKUPS=${backups}`)
      .replace('/run/lock/chunmo-staging-deploy.lock', join(root, 'lock'));
    const result = spawnSync('bash', ['-c', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        CHECK_LOG: join(root, 'log'),
        CHECK_FAIL: fail ? '1' : '0',
      },
    });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.equal(readFileSync(join(base, 'nginx.conf'), 'utf8'), 'unchanged private/public config');
    if (fail) {
      assert.equal(readFileSync(join(root, 'log'), 'utf8'), 'backup\n');
      assert.equal(readdirSync(backups).length, 0);
      assert.ok(!result.stdout.includes('PASS'));
    } else {
      assert.equal(readFileSync(join(root, 'log'), 'utf8'), 'backup\narchive\narchive\n');
      const snapshot = join(backups, readdirSync(backups)[0]);
      assert.equal(statSync(snapshot).mode & 0o777, 0o700);
      assert.equal(readFileSync(join(snapshot, 'previous-release'), 'utf8').trim(), release);
      for (const file of readdirSync(snapshot))
        assert.equal(statSync(join(snapshot, file)).mode & 0o777, 0o600);
    }
  });
