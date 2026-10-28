import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { migrate } from '../server/migrate';
const mode = process.argv[2];
if (!['development', 'test'].includes(mode)) throw Error('Use development or test');
const path = `.env.${mode}.local`;
process.loadEnvFile(path);
const admin = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL!;
if (
  !['127.0.0.1', 'localhost'].includes(new URL(admin).hostname) ||
  new URL(admin).pathname !== `/chunmo_${mode}`
)
  throw Error('Local provisioning refuses remote databases');
await migrate(admin);
const c = new pg.Client({ connectionString: admin });
await c.connect();
try {
  if (!process.env.MIGRATION_DATABASE_URL) {
    const app = randomBytes(24).toString('hex'),
      priv = randomBytes(24).toString('hex');
    for (const [role, password] of [
      ['chunmo_app', app],
      ['chunmo_private', priv],
    ]) {
      const q = await c.query(
        "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text,$2::text) AS sql",
        [role, password],
      );
      await c.query(q.rows[0].sql);
    }
    let file = readFileSync(path, 'utf8');
    const appUrl = new URL(admin),
      privateUrl = new URL(admin);
    appUrl.username = 'chunmo_app';
    appUrl.password = app;
    privateUrl.username = 'chunmo_private';
    privateUrl.password = priv;
    file =
      file.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${appUrl}`) +
      `MIGRATION_DATABASE_URL=${admin}\nPRIVATE_DATABASE_URL=${privateUrl}\n`;
    writeFileSync(path, file, { mode: 0o600 });
  }
  const tables = [
    'cloud_workspace',
    'account',
    'workspace_state',
    'project',
    'person',
    'trade',
    'task',
    'purchase',
    'memo',
    'assignment',
    'project_permission',
    'auth_session',
    'login_limit',
    'audit_event',
    'account_note',
    'account_avatar',
    'department',
    'member_card',
    'card_avatar',
    'purchase_record',
    'purchase_action',
    'material_transfer',
    'transfer_submission',
    'material_operator',
    'material_item',
    'material_project_meta',
    'material_context',
    'material_event',
    'material_alert',
    'material_history',
    'assessment_recorder',
    'daily_assessment',
    'assessment_history',
    'assessment_submission',
    'import_preview',
    'imported_archive',
  ];
  await c.query('GRANT SELECT ON schema_migration TO chunmo_app');
  await c.query('GRANT USAGE ON SCHEMA public TO chunmo_app,chunmo_private');
  await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + tables.join(',') + ' TO chunmo_app');
  await c.query(
    'REVOKE UPDATE,DELETE ON audit_event,assessment_history,assessment_submission,material_event,material_history,purchase_action,transfer_submission FROM chunmo_app,chunmo_private',
  );
  await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON person_private TO chunmo_private');
  await c.query(
    'REVOKE DELETE ON daily_assessment,material_item,material_project_meta,material_context,material_alert,member_card,purchase_record,material_transfer FROM chunmo_app',
  );
  await c.query('GRANT INSERT ON audit_event TO chunmo_private');
  console.log(`Local ${mode} migrations and least-privilege runtime roles ready.`);
} finally {
  await c.end();
}
