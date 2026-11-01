import { pool, privatePool } from '../server/db';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
const target = new URL(process.env.DATABASE_URL!);
assert(
  process.env.APP_ENV === 'test' &&
    target.hostname === '127.0.0.1' &&
    target.pathname === '/chunmo_test',
  'local isolated test database only',
);
try {
  const sample = (
    await pool.query(
      "SELECT workspace_id FROM workspace_state WHERE jsonb_array_length(data->'projects')=20 AND jsonb_array_length(history->'records')=401 LIMIT 1",
    )
  ).rows[0];
  assert(sample, 'run the guarded large-workspace benchmark first');
  const milliseconds = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = await pool.query(
      'SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1',
      [sample.workspace_id],
    );
    assert.equal(result.rowCount, 1);
    milliseconds.push(Number((performance.now() - start).toFixed(3)));
  }
  const explain = (
    await pool.query(
      'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1',
      [sample.workspace_id],
    )
  ).rows[0]['QUERY PLAN'][0];
  const result = {
    environment:
      'local isolated PostgreSQL; synthetic 20-project / 401-history workspace; warm reads',
    readAndDriverDecodeMs: milliseconds,
    postgresExecutionMs: explain['Execution Time'],
    postgresPlanningMs: explain['Planning Time'],
    plan: explain.Plan['Node Type'],
    productionServerMeasured: false,
  };
  await mkdir('/tmp/chunmo-upgrade-performance', { recursive: true });
  await writeFile(
    '/tmp/chunmo-upgrade-performance/postgres-query.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
  await privatePool.end();
}
