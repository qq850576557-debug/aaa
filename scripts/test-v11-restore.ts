import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PNG } from 'pngjs';
import pg from 'pg';
import { newDeployment, url, identifier } from '../deploy/native/shared.ts';
import { cluster, grants, owner } from '../deploy/native/admin.ts';
import { backup, restoreCheck } from '../deploy/native/ops.ts';
// Run with --env-file=.env.test.local; all targets are guarded below.
const target = new URL(process.env.MIGRATION_DATABASE_URL!);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.pathname, '/chunmo_test');
const root = mkdtempSync('/tmp/chunmo-material-backup-'),
  conf = root + '/config',
  archives = root + '/archives';
mkdirSync(conf, { mode: 0o700 });
mkdirSync(archives, { mode: 0o700 });
const c = newDeployment(),
  suffix = randomBytes(4).toString('hex');
c.port = Number(target.port);
c.db = 'chunmo_assets_' + suffix + '_test';
for (const [key, r] of Object.entries(c.roles)) r.name = 'cm_assets_' + suffix + '_' + key;
writeFileSync(conf + '/control.json', JSON.stringify(c), { mode: 0o600 });
writeFileSync(conf + '/backup.key', randomBytes(32).toString('hex'), { mode: 0o600 });
writeFileSync(conf + '/runtime.env', 'PRIVATE_DATA_KEY=' + randomBytes(32).toString('hex') + '\n', {
  mode: 0o600,
});
const admin = new pg.Client({ connectionString: target.toString() });
await admin.connect();
try {
  await cluster(admin, c);
  await grants(c);
  await owner(c, 'backup_owner', randomBytes(20).toString('hex'));
  const app = new pg.Client({ connectionString: url(c, 'app') });
  await app.connect();
  let wid: string;
  try {
    const a = (await app.query('SELECT id,workspace_id FROM account')).rows[0];
    wid = a.workspace_id;
    await app.query(
      "INSERT INTO department(workspace_id,id,name,english_name) VALUES($1,'design','设计部','Design')",
      [wid],
    );
    await app.query(
      "INSERT INTO member_card(workspace_id,account_id,english_name,department_id,joined_on) VALUES($1,$2,'Chris','design','2020-09-01')",
      [wid, a.id],
    );
    for (const table of [
      'material_item',
      'material_project_meta',
      'material_context',
      'material_alert',
    ])
      await app.query(
        `INSERT INTO ${table}(workspace_id,id,version,payload) VALUES($1,'sample',1,$2)`,
        [wid, JSON.stringify({ id: 'sample', costMicros: '1234567890', quantity: '100.123' })],
      );
    await app.query('INSERT INTO material_operator VALUES($1,$2)', [wid, a.id]);
    await app.query(
      "INSERT INTO material_event(workspace_id,id,seq,request_id,body_hash,payload) VALUES($1,'flow',1,'request','hash',$2)",
      [wid, JSON.stringify({ id: 'flow', costMicros: '1234567890', baseQty: '100.123' })],
    );
    await app.query(
      "INSERT INTO material_history(workspace_id,id,entity_id,actor_id,actor_name,after_value) VALUES($1,'history','flow',$2,'记录时姓名',$3)",
      [wid, a.id, JSON.stringify({ id: 'flow', reason: '现场核查' })],
    );
    await assert.rejects(
      app.query('DELETE FROM material_event WHERE workspace_id=$1', [wid]),
      (e: any) => e.code === '42501',
    );
    await app.query("UPDATE member_card SET job_title='设计师' WHERE workspace_id=$1", [wid]);
    await app.query(
      "INSERT INTO purchase_record(workspace_id,id,project_id,payload,created_by,created_name,created_at,updated_by,updated_name,completed_by,completed_name,completed_at) VALUES($1,'purchase','project',$2,$3,'创建人',now(),$3,'修改人',$3,'完成人',now())",
      [wid, JSON.stringify({ status: '已完成', quantity: '10.123' }), a.id],
    );
    await app.query(
      "INSERT INTO purchase_action(workspace_id,id,purchase_id,actor_id,actor_name,operation,after_value) VALUES($1,'purchase-action','purchase',$2,'当时姓名','完成',$3)",
      [wid, a.id, JSON.stringify({ status: '已完成' })],
    );
    await app.query("INSERT INTO material_transfer VALUES($1,'transfer',3,$2)", [
      wid,
      JSON.stringify({
        status: '部分接收',
        sent: '60.000',
        received: '25.000',
        returned: '20.000',
        lost: '0.000',
      }),
    ]);
    await app.query("INSERT INTO transfer_submission VALUES($1,'request-v11','hash',$2)", [
      wid,
      JSON.stringify({ id: 'transfer', version: 3 }),
    ]);
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    await app.query(
      "INSERT INTO card_avatar(account_id,png,version) VALUES($1,$2,'independent-card')",
      [a.id, png],
    );
    for (const table of ['purchase_action', 'transfer_submission'])
      await assert.rejects(
        app.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [wid]),
        (e: any) => e.code === '42501',
      );
    await app.query(
      "INSERT INTO work_record(workspace_id,id,project_id,project_name,title,status,version,created_by,created_name,updated_by,updated_name) VALUES($1,'record','project','备份工地','核验看板备份','持续跟进',1,$2,'当时姓名',$2,'当时姓名')",
      [wid, a.id],
    );
    await app.query(
      "INSERT INTO record_history(workspace_id,record_id,actor_id,actor_name,operation,changed_fields,after_value) VALUES($1,'record',$2,'当时姓名','create','[\"status\"]','{\"status\":\"持续跟进\"}')",
      [wid, a.id],
    );
    await app.query(
      'INSERT INTO record_submission VALUES($1,\'board-request\',$2,\'hash\',\'{"id":"record","version":1}\')',
      [wid, a.id],
    );
    for (const table of ['work_record', 'record_history', 'record_submission'])
      await assert.rejects(
        app.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [wid]),
        (e: any) => e.code === '42501',
      );
  } finally {
    await app.end();
  }
  const file = await backup(conf, archives, process.env.CHUNMO_TEST_PG_DUMP || 'pg_dump');
  const check = await restoreCheck(
    conf,
    file,
    process.env.CHUNMO_TEST_PG_RESTORE || 'pg_restore',
    async (name, config) => {
      await admin.query(
        `CREATE DATABASE ${identifier(name)} OWNER ${identifier(config.roles.migrator.name)} TEMPLATE template0`,
      );
      await admin.query(`REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`);
    },
  );
  const restored = new pg.Client({ connectionString: url(c, 'migrator', check) });
  await restored.connect();
  try {
    const card = (
      await restored.query(
        "SELECT english_name,department_id,to_char(joined_on,'YYYY-MM-DD') joined FROM member_card",
      )
    ).rows[0];
    assert.deepEqual(card, {
      english_name: 'Chris',
      department_id: 'design',
      joined: '2020-09-01',
    });
    assert.deepEqual((await restored.query('SELECT payload FROM material_event')).rows[0].payload, {
      id: 'flow',
      costMicros: '1234567890',
      baseQty: '100.123',
    });
    for (const t of [
      'material_item',
      'material_project_meta',
      'material_context',
      'material_alert',
      'material_operator',
      'material_event',
      'material_history',
      'member_card',
      'department',
    ])
      assert.equal((await restored.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 1, t);

    for (const table of [
      'purchase_record',
      'purchase_action',
      'material_transfer',
      'transfer_submission',
      'card_avatar',
      'work_record',
      'record_history',
      'record_submission',
    ])
      assert.equal(
        (await restored.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        1,
        table,
      );
    assert.equal(
      (await restored.query('SELECT job_title FROM member_card')).rows[0].job_title,
      '设计师',
    );
    assert.deepEqual(
      (await restored.query('SELECT payload FROM material_transfer')).rows[0].payload,
      { status: '部分接收', sent: '60.000', received: '25.000', returned: '20.000', lost: '0.000' },
    );
    assert.equal(
      (await restored.query('SELECT version FROM card_avatar')).rows[0].version,
      'independent-card',
    );
    const manifest = JSON.parse(readFileSync(file + '.json', 'utf8'));
    assert.equal(manifest.counts.material_event, 1);
    assert.equal(manifest.counts.material_history, 1);
    assert.equal(manifest.counts.work_record, 1);
    assert.equal(manifest.counts.record_history, 1);
    assert.equal(
      (await restored.query('SELECT status FROM work_record')).rows[0].status,
      '持续跟进',
    );
    assert.equal(
      (await restored.query('SELECT actor_name FROM record_history')).rows[0].actor_name,
      '当时姓名',
    );
    console.log(
      'PASS V1.1 record board/history/idempotency, purchase provenance/history, partial transfer/submissions, independent card image, job title, private join date and immutable material rows restored; both isolated databases retained.',
    );
  } finally {
    await restored.end();
  }
} finally {
  await admin.end();
}
