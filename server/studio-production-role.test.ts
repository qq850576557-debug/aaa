import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWorkspace } from './store';
import { passwordHash } from './auth';
import { migrate } from './migrate';
import { emptyStudio } from '../src/lib/studio-daily';
import { pool, privatePool } from './db';

test('real HTTP studio saves succeed with SELECT-only cloud_workspace; owner/staff and business state remain protected', async () => {
  const original = new URL(process.env.MIGRATION_DATABASE_URL!);
  assert.equal(process.env.APP_ENV, 'test');
  assert.equal(original.hostname, '127.0.0.1');
  assert.equal(original.pathname, '/chunmo_test');
  const suffix = randomBytes(5).toString('hex'),
    name = 'chunmo_studio_' + suffix + '_test',
    role = 'cm_studio_' + suffix,
    password = randomBytes(32).toString('hex');
  const admin = new pg.Client({ connectionString: original.toString() });
  await admin.connect();
  const target = new URL(original);
  target.pathname = '/' + name;
  let db: pg.Client | undefined, child: ReturnType<typeof spawn> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await migrate(target.toString());
    db = new pg.Client({ connectionString: target.toString() });
    await db.connect();
    const login = 'owner_' + suffix,
      employee = 'staff_' + suffix,
      pwd = randomBytes(20).toString('hex'),
      hash = await passwordHash(pwd);
    await db.query('BEGIN');
    const ids = await createWorkspace(db, login, hash, '隔离权限复现');
    const employeeId = randomUUID();
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES($1,$2,$3,$4,'employee')",
      [employeeId, ids.workspaceId, employee, hash],
    );
    await db.query('COMMIT');
    await db.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
    await db.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    await db.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    // Reproduce the exact shared-table restriction responsible for production SQLSTATE 42501.
    await db.query(`REVOKE INSERT,UPDATE,DELETE ON cloud_workspace FROM "${role}"`);
    await db.query(`REVOKE DELETE ON studio_daily FROM "${role}"`);
    await db.query(`REVOKE UPDATE,DELETE ON studio_daily_submission FROM "${role}"`);
    const appUrl = new URL(target);
    appUrl.username = role;
    appUrl.password = password;
    const app = new pg.Client({ connectionString: appUrl.toString() });
    await app.connect();
    try {
      await assert.rejects(
        app.query('SELECT id FROM cloud_workspace FOR UPDATE'),
        (e: any) => e.code === '42501',
      );
    } finally {
      await app.end();
    }
    const before = (
      await db.query('SELECT * FROM workspace_state WHERE workspace_id=$1', [ids.workspaceId])
    ).rows;
    const code = `import {createServer} from 'node:http';import {createApp} from './server/app.ts';import {pool,privatePool} from './server/db.ts';import {assertDatabaseReady} from './server/database-readiness.ts';await assertDatabaseReady(pool);const s=createServer(createApp());s.listen(0,'127.0.0.1',()=>console.log('PORT:'+s.address().port));process.on('SIGTERM',async()=>{s.closeAllConnections();await new Promise(r=>s.close(r));await pool.end();await privatePool.end();process.exit(0);});`;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ENV: 'test',
        APP_ORIGIN: 'http://127.0.0.1:5180',
        DATABASE_URL: appUrl.toString(),
        PRIVATE_DATABASE_URL: appUrl.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const active = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Isolated API startup timeout')), 15000);
      active.stdout!.on('data', (chunk) => {
        const match = String(chunk).match(/PORT:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      active.once('exit', () => {
        clearTimeout(timer);
        reject(Error('Isolated API exited before readiness'));
      });
    });
    const url = 'http://127.0.0.1:' + port;
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      session?: { cookie: string; csrf: string },
    ) =>
      fetch(url + '/api' + path, {
        method,
        headers: {
          Origin: 'http://127.0.0.1:5180',
          'Content-Type': 'application/json',
          ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const signIn = async (login: string) => {
      const response = await request('/auth/login', 'POST', { login, password: pwd });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie')!.split(';')[0];
      const session = await (
        await request('/auth/session', 'GET', undefined, { cookie, csrf: '' })
      ).json();
      return { cookie, csrf: session.csrf };
    };
    const owner = await signIn(login),
      staff = await signIn(employee);
    assert.equal((await (await request('/health')).json()).capabilities.studioDaily, true);
    const value = emptyStudio();
    value.rules = [
      {
        id: randomUUID(),
        text: '权限复现要求',
        people: [employeeId],
        enabled: true,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        from: '',
        to: '',
      },
    ];
    assert.equal(
      (await request('/studio-daily', 'PUT', { requestId: randomUUID(), version: 0, value }, owner))
        .status,
      200,
    );
    value.rules[0].text = '修改后的权限复现要求';
    assert.equal(
      (await request('/studio-daily', 'PUT', { requestId: randomUUID(), version: 1, value }, owner))
        .status,
      200,
    );
    const rotation = {
      requestId: randomUUID(),
      version: 2,
      value: {
        action: 'configure',
        interval: 3,
        people: [employeeId, ids.id],
        start: '2026-11-14',
        currentDate: '2026-11-14',
      },
    };
    assert.equal((await request('/studio-daily/rotation', 'POST', rotation, owner)).status, 200);
    assert.equal((await request('/studio-daily/rotation', 'POST', rotation, staff)).status, 403);
    assert.equal(
      (await request('/studio-daily', 'PUT', { requestId: randomUUID(), version: 3, value }, staff))
        .status,
      403,
    );
    assert.equal(
      (await (await request('/studio-daily', 'GET', undefined, staff)).json()).value.rules[0].text,
      value.rules[0].text,
    );
    assert.equal((await request('/auth/logout', 'POST', {}, owner)).status, 200);
    const relog = await signIn(login);
    const saved = await (await request('/studio-daily', 'GET', undefined, relog)).json();
    assert.equal(saved.value.rotation.interval, 3);
    assert.equal(saved.value.rules[0].text, value.rules[0].text);
    assert.deepEqual(
      (await db.query('SELECT * FROM workspace_state WHERE workspace_id=$1', [ids.workspaceId]))
        .rows,
      before,
    );
    console.log('Retained isolated production-lock reproduction database: ' + name);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await db?.end();
    await admin.end();
    await pool.end();
    await privatePool.end();
  }
});
