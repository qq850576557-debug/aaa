import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('deployment bootstrap imports before API environment or keys exist', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "await import('./deploy/native/admin.ts');process.stdout.write('bootstrap-ready')",
    ],
    { cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'bootstrap-ready');
});
