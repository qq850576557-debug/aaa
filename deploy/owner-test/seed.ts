import pg from 'pg';
import { config } from '../../server/config';
import { passwordHash } from '../../server/auth';
import { createWorkspace } from '../../server/store';
import { newProject } from '../../src/lib/model';

const url = process.env.MIGRATION_DATABASE_URL ?? '';
const access = new URL(url);
if (config.APP_ENV !== 'test' || access.host !== '127.0.0.1:5441' || access.pathname !== '/chunmo_test')
  throw Error('Refusing to seed outside the independent owner test cluster');
const password = process.env.OWNER_PASSWORD;
if (!password || !/^[a-f0-9]{32}$/.test(password)) throw Error('Missing generated test password');

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('BEGIN');
  if ((await c.query('SELECT 1 FROM cloud_workspace LIMIT 1')).rowCount)
    throw Error('Expected an empty owner test database');
  await createWorkspace(c, 'owner-test-admin', await passwordHash(password), '春茉业主独立测试');
  const { workspace_id: id, data } = (await c.query('SELECT workspace_id,data FROM workspace_state')).rows[0];
  const projects = [
    { ...newProject(), name: '业主联调住宅 A（测试）' },
    { ...newProject(), name: '业主联调住宅 B（测试）' },
  ];
  for (const project of projects) await c.query(
    'INSERT INTO project(workspace_id,id,payload) VALUES($1,$2,$3)',
    [id, project.id, project],
  );
  await c.query('UPDATE workspace_state SET data=$2 WHERE workspace_id=$1', [id, { ...data, projects }]);
  await c.query('COMMIT');
} catch (error) {
  await c.query('ROLLBACK');
  throw error;
} finally {
  await c.end();
}
