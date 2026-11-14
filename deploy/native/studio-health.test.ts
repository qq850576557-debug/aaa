import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireStudioHealth } from './studio-health';
test('deployment rejects old SELECT 1-only and degraded module health, accepts explicit readiness', () => {
  for (const value of [{ ok: true }, { ok: true, capabilities: { studioDaily: false } }])
    assert.throws(() => requireStudioHealth({ status: 200, value }), /studio daily/);
  assert.throws(() =>
    requireStudioHealth({ status: 503, value: { ok: true, capabilities: { studioDaily: true } } }),
  );
  assert.doesNotThrow(() =>
    requireStudioHealth({ status: 200, value: { ok: true, capabilities: { studioDaily: true } } }),
  );
});
