// Read-only production inventory. Never prints connection strings, account names or raw logs.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export const migrationChecksum = 'd505a4398e6562f44f3b47cd420c6cf7999b6038eebed9f28ff29d3bd377e523';
export async function databaseReport(db) {
  await db.query('BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout='5s'");
    const migrations = await db.query(
      "SELECT name,checksum FROM schema_migration WHERE name='015_studio_daily.sql'",
    );
    const result = {
      migration015: migrations.rows[0] || null,
      checksumMatches: migrations.rows[0]?.checksum === migrationChecksum,
      tables: {},
    };
    for (const table of ['studio_daily', 'studio_daily_submission']) {
      const exists = (
        await db.query('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + table])
      ).rows[0].present;
      const permissions = {};
      if (exists)
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
          permissions[privilege] = (
            await db.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [
              'public.' + table,
              privilege,
            ])
          ).rows[0].allowed;
      result.tables[table] = { exists, permissions };
    }
    const trigger =
      await db.query(`SELECT t.tgenabled AS enabled,t.tgtype AS type,p.proname AS function
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass('public.studio_daily_submission') AND t.tgname='studio_daily_submission_immutable'`);
    result.receiptTrigger = trigger.rows[0] || null;
    result.runtimeRole = (
      await db.query(
        'SELECT current_user AS name,rolsuper AS superuser,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    result.ready =
      result.checksumMatches &&
      ['SELECT', 'INSERT', 'UPDATE'].every((p) => result.tables.studio_daily.permissions[p]) &&
      ['SELECT', 'INSERT'].every((p) => result.tables.studio_daily_submission.permissions[p]) &&
      ['O', 'A'].includes(result.receiptTrigger?.enabled) &&
      result.receiptTrigger?.type === 27 &&
      result.receiptTrigger?.function === 'immutable_audit_event';
    return result;
  } finally {
    await db.query('ROLLBACK');
  }
}
export function safeDatabaseLogs(raw) {
  return raw.split('\n').flatMap((line) => {
    try {
      const row = JSON.parse(line),
        entry = JSON.parse(row.MESSAGE);
      if (
        entry.event !== 'database.operation_failed' ||
        !/^(GET|PUT|POST) \/api\/studio-daily(?:\/rotation)?$/.test(entry.operation) ||
        !/^[A-Z0-9_]{2,24}$/.test(entry.code)
      )
        return [];
      return [
        {
          operation: entry.operation,
          code: entry.code,
          timestamp: /^\d+$/.test(row.__REALTIME_TIMESTAMP || '') ? row.__REALTIME_TIMESTAMP : null,
        },
      ];
    } catch {
      return [];
    }
  });
}
async function main() {
  if (process.getuid?.() !== 0) throw Object.assign(Error(), { code: 'ROOT_REQUIRED' });
  const release = realpathSync('/opt/chunmo-staging/current');
  if (!/^\/opt\/chunmo-staging\/releases\/[a-f0-9]{7,40}$/.test(release))
    throw Object.assign(Error(), { code: 'UNRECOGNIZED_RELEASE' });
  const report = {
    currentRelease: release,
    readOnly: true,
    apiSha256: createHash('sha256')
      .update(readFileSync(join(release, 'dist-api/server.mjs')))
      .digest('hex'),
  };
  const services = [
    'chunmo-staging-api',
    'chunmo-staging-web',
    'chunmo-mini-photo',
    'chunmo-mini-workbench',
  ];
  report.services = Object.fromEntries(
    services.map((s) => {
      try {
        return [
          s,
          execFileSync('/usr/bin/systemctl', ['is-active', s], {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim() === 'active',
        ];
      } catch {
        return [s, false];
      }
    }),
  );
  try {
    const { Client } = createRequire(join(release, 'package.json'))('pg');
    const config = JSON.parse(readFileSync('/etc/chunmo-staging/control.json', 'utf8'));
    const role = config.roles.app;
    const db = new Client({
      host: config.host,
      port: config.port,
      database: config.db,
      user: role.name,
      password: role.password,
      connectionTimeoutMillis: 5000,
    });
    await db.connect();
    try {
      report.database = await databaseReport(db);
    } finally {
      await db.end();
    }
  } catch (e) {
    report.database = {
      ready: false,
      errorCode: /^[A-Z0-9_]{2,30}$/.test(e.code || '') ? e.code : 'CHECK_FAILED',
    };
  }
  try {
    report.recentDatabaseFailures = safeDatabaseLogs(
      execFileSync(
        '/usr/bin/journalctl',
        ['-u', 'chunmo-staging-api', '--since=-48h', '--no-pager', '-n', '500', '-o', 'json'],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ),
    );
  } catch {
    report.recentDatabaseFailures = [];
  }
  report.apiIncludesStudio = readFileSync(join(release, 'dist-api/server.mjs'), 'utf8').includes(
    '/api/studio-daily/rotation',
  );
  report.backupDirectoryPresent = existsSync('/var/backups/chunmo-staging');
  console.log(JSON.stringify(report, null, 2));
  console.log('READ ONLY: no migration/grant/deploy/restart, no business rows or secrets printed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(
      'STOP: ' + (/^[A-Z0-9_]{2,30}$/.test(e.code || '') ? e.code : 'READ_ONLY_CHECK_FAILED'),
    );
    process.exitCode = 1;
  });
