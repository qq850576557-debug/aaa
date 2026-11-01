import type pg from 'pg';

// Keep the deployed API from accepting traffic against only the old record-board schema.
export const requiredMigrations = [
  '010_record_board.sql',
  '011_record_owner.sql',
  '012_legacy_classification.sql',
  '013_cloud_versions.sql',
  '014_mentions.sql',
];

export async function assertDatabaseReady(db: pg.Pool | pg.Client) {
  const applied = await db.query('SELECT name FROM schema_migration');
  const missing = requiredMigrations.filter((name) => !applied.rows.some((r) => r.name === name));
  if (missing.length)
    throw Error(
      'Database upgrade incomplete; apply reviewed migrations and runtime grants: ' +
        missing.join(', '),
    );
  // Read-only checks run as the actual application role, not the migration owner.
  await db.query('SELECT owner,mention_ids FROM work_record LIMIT 0');
  for (const table of [
    'legacy_record_link',
    'workspace_history_revision',
    'record_version',
    'cloud_restore_backup',
    'mention_notification',
  ])
    await db.query(`SELECT * FROM ${table} LIMIT 0`);
  const permissions = await db.query(`SELECT
    has_table_privilege(current_user,'record_version','INSERT') AND
    has_table_privilege(current_user,'record_version','DELETE') AND
    has_table_privilege(current_user,'workspace_history_revision','INSERT') AND
    has_table_privilege(current_user,'cloud_restore_backup','INSERT') AND
    has_table_privilege(current_user,'legacy_record_link','INSERT') AND
    has_table_privilege(current_user,'mention_notification','INSERT') AND
    has_column_privilege(current_user,'mention_notification','read_at','UPDATE') AND
    has_sequence_privilege(current_user,'mention_notification_id_seq','USAGE') AND
    has_sequence_privilege(current_user,'legacy_record_link_id_seq','USAGE') AS ready`);
  if (!permissions.rows[0]?.ready)
    throw Error(
      'Database runtime grants incomplete; apply reviewed runtime grants before API startup',
    );
}

export function databaseFailure(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  if (['42P01', '42703', '42501', '42883'].includes(code))
    return {
      code: 'DATABASE_SCHEMA_NOT_READY',
      error: '服务端数据库升级或授权未完成，请联系管理员；现有数据和草稿未覆盖',
    };
  if (
    /^(08|53)/.test(code) ||
    ['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  )
    return {
      code: 'DATABASE_UNAVAILABLE',
      error: '数据库暂时不可用，请稍后重试；现有数据和草稿未覆盖',
    };
  return null;
}

export function logDatabaseFailure(error: unknown, operation: string) {
  const code = (error as { code?: unknown } | null)?.code;
  // Never log SQL, connection URLs, tokens, request bodies or database error details.
  console.error(
    JSON.stringify({
      event: 'database.operation_failed',
      operation,
      code: typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'UNKNOWN',
    }),
  );
}
