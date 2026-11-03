import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const scenario of ['legacy', 'outside', 'incomplete', 'writable', 'backup-fails']) {
  test(`current release compatibility: ${scenario}`, () => {
    const base = mkdtempSync(join(tmpdir(), 'cm-legacy-'));
    const old = join(base, scenario === 'outside' ? 'outside' : 'releases/df961df');
    for (const dir of ['dist', 'dist-api']) mkdirSync(join(old, dir), { recursive: true });
    writeFileSync(join(old, 'dist/index.html'), 'old-page');
    if (scenario !== 'incomplete') writeFileSync(join(old, 'dist-api/server.mjs'), 'old-api');
    if (scenario === 'writable') chmodSync(join(old, 'dist/index.html'), 0o666);
    symlinkSync(old, join(base, 'current'));
    const source = readFileSync('deploy/native/deploy.sh', 'utf8');
    const block = source
      .split('# BEGIN CURRENT RELEASE CHECK')[1]
      .split('# END CURRENT RELEASE CHECK')[0];
    const script = `set -Eeuo pipefail
fail() { echo "$*" >&2; exit 1; }
BASE=$1
RELEASE=$BASE
PREVIOUS=
CONF=config
BACKUPS=backups
DUMP=dump
NODE=backup_stub
backup_stub() { printf backup > "$BASE/backup-called"; return ${scenario === 'backup-fails' ? 1 : 0}; }
${block.replace('! -user root', `! -user ${process.getuid!()}`)}
printf continue > "$BASE/continued"
`;
    const result = spawnSync('bash', ['-c', script, '_', base], { encoding: 'utf8' });
    assert.equal(result.status, scenario === 'legacy' ? 0 : 1, result.stderr);
    assert.equal(existsSync(join(base, 'continued')), scenario === 'legacy');
    assert.equal(
      existsSync(join(base, 'backup-called')),
      ['legacy', 'backup-fails'].includes(scenario),
    );
    assert.equal(readFileSync(join(old, 'dist/index.html'), 'utf8'), 'old-page');
    assert.equal(existsSync(join(old, '.verified-build')), false);
  });
}
