import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function migrate(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(62109684)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir('server/migrations'))
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      const sql = await readFile('server/migrations/' + name, 'utf8'),
        hash = createHash('sha256').update(sql).digest('hex');
      const prior = await c.query('SELECT checksum FROM schema_migration WHERE name=$1', [name]);
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== hash)
          throw Error('Applied migration checksum mismatch: ' + name);
      } else {
        await c.query(sql);
        await c.query('INSERT INTO schema_migration VALUES($1,$2,now())', [name, hash]);
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
if (process.argv[1]?.endsWith('migrate.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw Error('MIGRATION_DATABASE_URL required');
  await migrate(url);
  console.log('Database migrations verified/applied.');
}
