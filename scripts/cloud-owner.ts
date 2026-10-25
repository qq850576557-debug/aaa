import pg from 'pg';
import { passwordSchema } from '../src/lib/password';
import { passwordHash } from '../server/auth';
import { createWorkspace } from '../server/store';
import { pool, privatePool } from '../server/db';
const login = process.env.OWNER_LOGIN?.toLowerCase(),
  password = process.env.OWNER_PASSWORD;
if (
  !login ||
  !/^[a-z0-9_.@-]{3,80}$/.test(login) ||
  !password ||
  !passwordSchema.safeParse(password).success ||
  !process.env.MIGRATION_DATABASE_URL
)
  throw Error(
    'Provide OWNER_LOGIN, OWNER_PASSWORD (8–128 characters), and migration credentials through the environment; never command arguments.',
  );
const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  await c.query('LOCK TABLE account IN EXCLUSIVE MODE');
  if ((await c.query('SELECT 1 FROM account LIMIT 1')).rowCount)
    throw Error('Initial owner already exists; refusing to overwrite accounts');
  await createWorkspace(
    c,
    login,
    await passwordHash(password),
    process.env.WORKSPACE_NAME ?? '春茉工作室',
  );
  await c.query('COMMIT');
  console.log('Initial owner created; no credentials printed.');
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  await c.end();
  await pool.end();
  await privatePool.end();
}
