import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const failure of ['none', 'restart', 'health'])
  test(`studio readiness failure rollback verifies ${failure}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-rollback-')),
      base = join(root, 'base'),
      bin = join(root, 'bin'),
      old = join(root, 'old'),
      next = join(root, 'new');
    for (const dir of [base, bin, old, next]) mkdirSync(dir);
    symlinkSync(next, join(base, 'current'));
    writeFileSync(join(base, 'nginx.conf'), 'new config');
    writeFileSync(join(root, 'previous-nginx'), 'original config');
    writeFileSync(
      join(bin, 'systemctl'),
      '#!/bin/sh\nif [ "$1" = restart ] && [ "$FAILURE" = restart ]; then exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\n[ "$FAILURE" != health ]\n', { mode: 0o755 });
    const script = readFileSync('deploy/native/deploy.sh', 'utf8');
    const fn = script.slice(
      script.indexOf('on_error() {'),
      script.indexOf('# Explicit certificate-only'),
    );
    const p = spawnSync('bash', ['-c', fn + '\nfalse; on_error 99'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        BASE: base,
        PREVIOUS: old,
        RELEASE: next,
        CONF: root,
        TLS: root,
        NODE: '',
        NGINX_PREVIOUS: join(root, 'previous-nginx'),
        READ_ONLY_SMOKE: '1',
        PROMOTED: '1',
        PHASE: 'module-check',
        FAILURE: failure,
      },
    });
    assert.equal(p.status, 1);
    assert.equal(realpathSync(join(base, 'current')), old);
    assert.equal(readFileSync(join(base, 'nginx.conf'), 'utf8'), 'original config');
    assert.equal(p.stderr.includes('ROLLBACK_HEALTH_FAILED'), failure !== 'none');
    assert.equal(p.stderr.includes('PASS previous release'), failure === 'none');
  });
