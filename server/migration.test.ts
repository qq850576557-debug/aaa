import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { emptyData, newProject } from '../src/lib/model';
import { migrate } from './migrate';
import { assertDatabaseReady } from './database-readiness';

test('010-only deployment reproduces missing record fields/tables and refuses new API until additive upgrade', async () => {
  const raw = process.env.MIGRATION_DATABASE_URL!;
  const original = new URL(raw);
  assert.equal(original.hostname, '127.0.0.1');
  assert.equal(original.pathname, '/chunmo_test');
  const admin = new pg.Client({ connectionString: raw });
  await admin.connect();
  const name = 'chunmo_readiness_' + randomUUID().replaceAll('-', '').slice(0, 10) + '_test';
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
    for (const file of (await readdir('server/migrations'))
      .filter((f) => f.endsWith('.sql') && f <= '010_record_board.sql')
      .sort()) {
      const sql = await readFile('server/migrations/' + file, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    await assert.rejects(
      db.query('SELECT owner FROM work_record LIMIT 0'),
      (e: any) => e.code === '42703',
    );
    await assert.rejects(
      db.query('SELECT * FROM legacy_record_link LIMIT 0'),
      (e: any) => e.code === '42P01',
    );
    await assert.rejects(
      assertDatabaseReady(db),
      /011_record_owner.sql.*012_legacy_classification.sql.*013_cloud_versions.sql/,
    );
    const inventoryData = emptyData();
    inventoryData.projects = [{ ...newProject(), id: 'inventory-site', name: '旧库只读核对' }];
    await db.query('BEGIN');
    await db.query(
      "INSERT INTO cloud_workspace VALUES('inventory-studio','只读核对','inventory-owner')",
    );
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES('inventory-owner','inventory-studio','inventory_owner','test-only-hash','owner')",
    );
    await db.query('INSERT INTO workspace_state VALUES($1,0,$2,$3)', [
      'inventory-studio',
      JSON.stringify(inventoryData),
      JSON.stringify({ version: 1, records: [], snapshots: {} }),
    ]);
    await db.query('COMMIT');
    const beforeInventory = (await db.query('SELECT * FROM workspace_state')).rows;
    // Execute the exact psql script with pg, emulating only psql's \gexec metacommand.
    const inventorySql = await readFile('deploy/native/upgrade-inventory.sql', 'utf8');
    for (const chunk of inventorySql.split(/^\s*\\gexec\s*$/m)) {
      const sql = chunk.replace(/^\s*\\[^\n]*$/gm, '').trim();
      if (!sql) continue;
      const result = await db.query(sql),
        last = Array.isArray(result) ? result.at(-1)! : result;
      for (const row of last.rows ?? []) if (typeof row.sql === 'string') await db.query(row.sql);
    }
    assert.deepEqual((await db.query('SELECT * FROM workspace_state')).rows, beforeInventory);
    assert.equal((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n, 10);
    await migrate(target.toString());
    await migrate(target.toString());
    await assertDatabaseReady(db);
    const role = new URL(process.env.DATABASE_URL!).username;
    assert.match(role, /^[a-z_][a-z0-9_]*$/);
    await db.query(
      `GRANT SELECT ON schema_migration,work_record,legacy_record_link,workspace_history_revision,record_version,cloud_restore_backup,mention_notification TO "${role}"`,
    );
    await db.query(`SET ROLE "${role}"`);
    try {
      await assert.rejects(assertDatabaseReady(db), /runtime grants incomplete/);
    } finally {
      await db.query('RESET ROLE');
    }
    await db.query(
      `GRANT INSERT ON legacy_record_link,workspace_history_revision,record_version,cloud_restore_backup TO "${role}"`,
    );
    await db.query(`GRANT DELETE ON record_version TO "${role}"`);
    await db.query(`GRANT USAGE ON SEQUENCE legacy_record_link_id_seq TO "${role}"`);
    await db.query(`GRANT INSERT ON mention_notification TO "${role}"`);
    await db.query(`GRANT UPDATE(read_at) ON mention_notification TO "${role}"`);
    await db.query(`GRANT USAGE ON SEQUENCE mention_notification_id_seq TO "${role}"`);
    await db.query(`SET ROLE "${role}"`);
    try {
      await assertDatabaseReady(db);
    } finally {
      await db.query('RESET ROLE');
    }
    console.log('Retained isolated readiness-validation database: ' + name);
  } finally {
    await db?.end();
    await admin.end();
  }
});

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
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES('old-legacy-separators','old-workspace','_legacy..user','legacy-hash','employee')",
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
    assert.equal((await db.query('SELECT count(*)::int n FROM daily_assessment')).rows[0].n, 0);
    for (const table of [
      'purchase_record',
      'purchase_action',
      'material_transfer',
      'transfer_submission',
      'card_avatar',
      'work_record',
      'record_history',
      'record_submission',
      'legacy_migration_batch',
      'legacy_record_link',
      'workspace_history_revision',
      'record_version',
      'cloud_restore_backup',
    ])
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
    await db.query(
      "INSERT INTO member_card(workspace_id,account_id) VALUES('old-workspace','old-owner')",
    );
    assert.equal(
      (await db.query("SELECT job_title FROM member_card WHERE account_id='old-owner'")).rows[0]
        .job_title,
      '',
    );
    assert.equal((await db.query('SELECT count(*)::int n FROM assessment_history')).rows[0].n, 0);
    assert.equal(
      (await db.query("SELECT login_key FROM account WHERE id='old-legacy-separators'")).rows[0]
        .login_key,
      '_legacy..user',
    );
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

test('004 canonical collisions stop migration atomically without rewriting legacy identities', async () => {
  const raw = process.env.MIGRATION_DATABASE_URL!;
  const original = new URL(raw);
  assert.equal(original.hostname, '127.0.0.1');
  assert.equal(original.pathname, '/chunmo_test');
  const admin = new pg.Client({ connectionString: raw });
  await admin.connect();
  const name = 'chunmo_login_collision_' + randomUUID().replaceAll('-', '').slice(0, 10) + '_test';
  const url = new URL(raw);
  url.pathname = '/' + name;
  let db: pg.Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(
      'CREATE TABLE schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of ['001_cloud.sql', '002_assignment_scope.sql', '003_accounts_audit.sql']) {
      const sql = await readFile('server/migrations/' + file, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    await db.query('BEGIN');
    await db.query(
      "INSERT INTO cloud_workspace VALUES('legacy-workspace','legacy','legacy-owner')",
    );
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES('legacy-owner','legacy-workspace','owner_a','hash-owner','owner'),('legacy-staff','legacy-workspace','ＯＷＮＥＲ_Ａ','hash-staff','employee')",
    );
    await db.query('COMMIT');
    const before = (await db.query('SELECT id,login,password_hash,role FROM account ORDER BY id'))
      .rows;
    await assert.rejects(migrate(url.toString()), (e: any) => e.code === '23505');
    assert.deepEqual(
      (await db.query('SELECT id,login,password_hash,role FROM account ORDER BY id')).rows,
      before,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM schema_migration WHERE name='004_login_change.sql'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='account' AND column_name IN ('login_key','login_changed_at')",
        )
      ).rows[0].n,
      0,
    );
    console.log('Retained isolated canonical-collision database: ' + name);
  } finally {
    await db?.end();
    await admin.end();
  }
});

test('011 owner is an additive upgrade that preserves pre-existing board content, metadata and receipts', async () => {
  const raw = process.env.MIGRATION_DATABASE_URL!;
  const url = new URL(raw);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/chunmo_test');
  const admin = new pg.Client({ connectionString: raw });
  await admin.connect();
  const name = 'chunmo_record_owner_' + randomUUID().replaceAll('-', '').slice(0, 12) + '_test';
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
    for (const file of (await readdir('server/migrations'))
      .filter((n) => n.endsWith('.sql') && n < '011_')
      .sort()) {
      const sql = await readFile('server/migrations/' + file, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    await db.query('BEGIN');
    await db.query("INSERT INTO cloud_workspace VALUES('legacy-studio','旧工作室','legacy-owner')");
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES('legacy-owner','legacy-studio','legacy_owner','untouched-test-hash','owner')",
    );
    await db.query(
      "INSERT INTO work_record(workspace_id,id,project_id,project_name,title,node_date,status,notes,follow_up,version,created_by,created_name,updated_by,updated_name) VALUES('legacy-studio','legacy-record','legacy-project','旧项目','保留旧事项','2026-10-30','待执行','原始内容','原始跟进',3,'legacy-owner','旧姓名','legacy-owner','旧姓名')",
    );
    await db.query('COMMIT');
    const before = (await db.query("SELECT * FROM work_record WHERE id='legacy-record'")).rows[0];
    await migrate(target.toString());
    await migrate(target.toString());
    const after = (await db.query("SELECT * FROM work_record WHERE id='legacy-record'")).rows[0];
    assert.equal(after.owner, '');
    assert.deepEqual(after.mention_ids, []);
    const baseline = (
      await db.query("SELECT * FROM record_version WHERE record_id='legacy-record'")
    ).rows;
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].version, 3);
    assert.equal(baseline[0].baseline, true);
    assert.equal(baseline[0].snapshot.notes, '原始内容');
    assert.equal(baseline[0].snapshot.created_name, '旧姓名');
    delete after.owner;
    delete after.mention_ids;
    assert.deepEqual(after, before);
  } finally {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
