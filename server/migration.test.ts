import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { migrate } from './migrate';

test('V1.1 additive upgrade retains old identities, password hash, business rows and old-code audit inserts', async () => {
  const raw = process.env.MIGRATION_DATABASE_URL;
  assert.ok(raw);
  const original = new URL(raw);
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(original.hostname) && original.pathname === '/chunmo_test',
    'isolated local test cluster only',
  );
  const admin = new pg.Client({ connectionString: raw });
  await admin.connect();
  const name = 'chunmo_upgrade_' + randomUUID().replaceAll('-', '').slice(0, 12) + '_test';
  const target = new URL(raw);
  target.pathname = '/' + name;
  let db: pg.Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    db = new pg.Client({ connectionString: target.toString() });
    await db.connect();
    await db.query(
      'CREATE TABLE schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of ['001_cloud.sql', '002_assignment_scope.sql']) {
      const sql = await readFile('server/migrations/' + file, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    await db.query('BEGIN');
    await db.query("INSERT INTO cloud_workspace VALUES('old-workspace','旧工作室','old-owner')");
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES('old-owner','old-workspace','studio_owner','unchanged-test-hash','owner')",
    );
    await db.query(
      "INSERT INTO project VALUES('old-workspace','old-project','{\"id\":\"old-project\"}')",
    );
    await db.query(
      "INSERT INTO audit_event(id,workspace_id,actor_id,action,revision) VALUES('old-event','old-workspace','old-owner','workspace.save',1)",
    );
    await db.query('COMMIT');
    await migrate(target.toString());
    await migrate(target.toString());
    assert.deepEqual(
      (
        await db.query(
          "SELECT id,login,password_hash,role,display_name FROM account WHERE id='old-owner'",
        )
      ).rows[0],
      {
        id: 'old-owner',
        login: 'studio_owner',
        password_hash: 'unchanged-test-hash',
        role: 'owner',
        display_name: '',
      },
    );
    assert.equal((await db.query('SELECT count(*)::int n FROM project')).rows[0].n, 1);
    assert.equal(
      (await db.query("SELECT actor_display_name FROM audit_event WHERE id='old-event'")).rows[0]
        .actor_display_name,
      'studio_owner',
    );
    // Prior release INSERT shape remains valid for automatic code rollback.
    await db.query(
      "INSERT INTO audit_event(id,workspace_id,actor_id,action,revision) VALUES('old-code-new-event','old-workspace','old-owner','workspace.save',2)",
    );
    await assert.rejects(
      db.query("DELETE FROM audit_event WHERE id='old-event'"),
      (e: any) => e.code === '42501',
    );
    console.log('Retained isolated upgrade-validation database: ' + name);
  } finally {
    await db?.end();
    await admin.end();
  }
});
