import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error isolated JavaScript CLI module
import { auditProduction } from '../../scripts/audit-production.mjs';
const clean = {
  status: 0,
  stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }),
};
const unavailable = { status: 1, stdout: JSON.stringify({ error: { code: 'ECONNRESET' } }) };
for (const [label, outcomes, expected, calls] of [
  ['clean audit', [clean], 0, 1],
  ['transient failure', [unavailable, clean], 0, 2],
  ['persistent failure', [unavailable], 1, 3],
  ['malformed output', [{ status: 0, stdout: 'not-json' }], 1, 3],
  [
    'real vulnerability',
    [{ status: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 1 } } }) }],
    1,
    1,
  ],
  ['nonzero exit with empty counts', [{ ...clean, status: 1 }], 1, 3],
] as const) {
  test(`production audit: ${label}`, async () => {
    let count = 0;
    const waits: number[] = [];
    const result = await auditProduction(
      () => outcomes[Math.min(count++, outcomes.length - 1)],
      async (ms: number) => {
        waits.push(ms);
      },
      () => {},
    );
    assert.equal(result, expected);
    assert.equal(count, calls);
    assert.equal(waits.length, calls - 1);
  });
}
