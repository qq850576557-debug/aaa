import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseReport, safeDatabaseLogs } from './diagnose.mjs';
test('diagnostic reads migration, real application grants and immutable trigger without writing', async () => {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.APP_ENV, 'test');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.pathname.endsWith('_test'));
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    const r = await databaseReport(db);
    assert.equal(r.ready, true);
    assert.equal(r.tables.studio_daily.permissions.DELETE, false);
    assert.equal(r.tables.studio_daily_submission.permissions.UPDATE, false);
    assert.equal(r.tables.studio_daily_submission.permissions.DELETE, false);
  } finally {
    await db.end();
  }
});
test('diagnostic prints only whitelisted SQLSTATE/route metadata, excluding private log payloads', () => {
  const raw = JSON.stringify({
    __REALTIME_TIMESTAMP: '123',
    MESSAGE: JSON.stringify({
      event: 'database.operation_failed',
      operation: 'PUT /api/studio-daily',
      code: '42501',
      password: 'never-print',
      employee: 'private',
    }),
  });
  const result = safeDatabaseLogs(raw);
  assert.equal(result[0].code, '42501');
  assert.ok(!JSON.stringify(result).includes('never-print'));
  assert.deepEqual(safeDatabaseLogs('bad'), []);
});
