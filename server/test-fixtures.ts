import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { passwordHash } from './auth';
import { createWorkspace } from './store';
export async function fixtureAccounts() {
  if (
    process.env.APP_ENV !== 'test' ||
    !process.env.MIGRATION_DATABASE_URL ||
    new URL(process.env.MIGRATION_DATABASE_URL).pathname !== '/chunmo_test' ||
    !['127.0.0.1', 'localhost'].includes(new URL(process.env.MIGRATION_DATABASE_URL).hostname)
  )
    throw Error('Dedicated test database required');
  const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await admin.connect();
  const password = randomBytes(20).toString('hex'),
    login = 'owner_' + randomBytes(8).toString('hex'),
    employee = 'staff_' + randomBytes(8).toString('hex');
  try {
    await admin.query('BEGIN');
    const ids = await createWorkspace(admin, login, await passwordHash(password), '隔离测试工作室');
    const employeeId = randomUUID();
    await admin.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES($1,$2,$3,$4,'employee')",
      [employeeId, ids.workspaceId, employee, await passwordHash(password)],
    );
    await admin.query('COMMIT');
    return { ...ids, password, login, employee, employeeId };
  } catch (e) {
    await admin.query('ROLLBACK');
    throw e;
  } finally {
    await admin.end();
  }
}
