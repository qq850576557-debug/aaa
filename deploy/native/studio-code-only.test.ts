import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const fail of [false, true])
  test(`code-only update ${fail ? 'stops on missing readiness' : 'checks existing schema without config/migrate/grants/HBA'}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-code-only-')),
      base = join(root, 'base'),
      conf = join(root, 'conf'),
      release = join(root, 'release');
    for (const p of [base, conf, release]) mkdirSync(p);
    symlinkSync(release, join(base, 'current'));
    writeFileSync(join(conf, 'control.json'), 'retained private configuration');
    const node = join(root, 'node');
    writeFileSync(node, '#!/bin/bash\necho "$*" >> "$LOG"\n[[ $FAIL != 1 ]]\n', { mode: 0o755 });
    const source = readFileSync('deploy/native/deploy.sh', 'utf8');
    const block = source.split('# BEGIN DATABASE CONFIG\n')[1].split('# END DATABASE CONFIG')[0];
    const result = spawnSync(
      'bash',
      ['-c', 'set -Eeuo pipefail; fail(){ exit 1; }; ' + block + '\necho NEXT_PHASE'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE: base,
          CONF: conf,
          RELEASE: release,
          CODE_ONLY: '1',
          NODE: node,
          FAIL: fail ? '1' : '0',
          LOG: join(root, 'log'),
        },
      },
    );
    assert.equal(result.status, fail ? 1 : 0);
    assert.equal(result.stdout.includes('NEXT_PHASE'), !fail);
    const calls = readFileSync(join(root, 'log'), 'utf8');
    assert.match(calls, /studio-db-ready/);
    assert.doesNotMatch(calls, /cluster-input|admin\.mjs|migrate| hba | config /);
    assert.equal(
      readFileSync(join(conf, 'control.json'), 'utf8'),
      'retained private configuration',
    );
  });
