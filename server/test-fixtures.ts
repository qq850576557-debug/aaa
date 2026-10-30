import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { passwordHash } from './auth';
import { createWorkspace } from './store';
export async function fixtureQuery(sql: string, values: unknown[] = []) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.APP_ENV !== 'test' ||
    !url.pathname.endsWith('_test') ||
    !['127.0.0.1', 'localhost'].includes(url.hostname)
  )
    throw Error('Dedicated local test database required');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}
export async function fixtureAccounts(employeeCount = 1) {
  if (
    process.env.APP_ENV !== 'test' ||
    !process.env.MIGRATION_DATABASE_URL ||
    new URL(process.env.MIGRATION_DATABASE_URL).pathname !== '/chunmo_test' ||
    !['127.0.0.1', 'localhost'].includes(new URL(process.env.MIGRATION_DATABASE_URL).hostname)
  )
    throw Error('Dedicated test database required');
  if (!Number.isInteger(employeeCount) || employeeCount < 1 || employeeCount > 19)
    throw Error('Test fixture supports 1–19 employees');
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
    const employees = [{ id: employeeId, login: employee }];
    const extraHash = employeeCount > 1 ? await passwordHash(password) : '';
    for (let i = 1; i < employeeCount; i++) {
      const id = randomUUID(),
        login = 'staff_' + randomBytes(8).toString('hex');
      await admin.query(
        "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES($1,$2,$3,$4,'employee')",
        [id, ids.workspaceId, login, extraHash],
      );
      employees.push({ id, login });
    }
    await admin.query('COMMIT');
    return { ...ids, password, login, employee, employeeId, employees };
  } catch (e) {
    await admin.query('ROLLBACK');
    throw e;
  } finally {
    await admin.end();
  }
}
