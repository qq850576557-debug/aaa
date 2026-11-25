import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { hash } from '../../server/store';

const files = ['019_employee_wechat.sql', '019_employee_wechat_grants.sql'];

export async function migrateEmployeeWechatTest(database: string, staff: string) {
  const address = new URL(database);
  if (
    process.env.APP_ENV !== 'test' ||
    !['localhost', '127.0.0.1'].includes(address.hostname) ||
    !address.pathname.endsWith('_test') ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(staff)
  )
    throw Error('019 requires an isolated loopback _test database and a verified staff role');
  const contents = await Promise.all(
    files.map((name) =>
      readFile(new URL('../../server/proposed/' + name, import.meta.url), 'utf8'),
    ),
  );
  const db = new pg.Client({ connectionString: database });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(62109684)');
    const ledger = (
      await db.query(
        'SELECT name,checksum FROM public.schema_migration WHERE name=ANY($1) ORDER BY name',
        [files],
      )
    ).rows;
    if (
      ledger.length &&
      (ledger.length !== files.length ||
        files.some(
          (name, i) => ledger.find((entry) => entry.name === name)?.checksum !== hash(contents[i]),
        ))
    )
      throw Error('019 migration checksum mismatch or incomplete ledger');
    const role = (
      await db.query('SELECT rolsuper,rolcanlogin FROM pg_roles WHERE rolname=$1', [staff])
    ).rows[0];
    if (!role?.rolcanlogin || role.rolsuper) throw Error('019 requires a non-superuser staff role');
    if (!ledger.length) {
      await db.query(contents[0]);
      await db.query(contents[1].replaceAll(':"staff_role"', '"' + staff + '"'));
      for (const [i, name] of files.entries())
        await db.query('INSERT INTO public.schema_migration(name,checksum) VALUES($1,$2)', [
          name,
          hash(contents[i]),
        ]);
    }
    const result = (
      await db.query(
        `SELECT (SELECT bool_and(has_table_privilege($1,'public.employee_wechat_binding', privilege))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) privilege)
        AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='clear_employee_wechat_on_credential_change' AND tgenabled='O')
        AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='retire_employee_project_permission' AND tgenabled='O') AS ready`,
        [staff],
      )
    ).rows[0];
    if (!result.ready) throw Error('019 schema or staff privileges are incomplete');
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.env.MIGRATION_DATABASE_URL || !process.argv[2])
    throw Error('Provide MIGRATION_DATABASE_URL and the isolated staff role');
  await migrateEmployeeWechatTest(process.env.MIGRATION_DATABASE_URL, process.argv[2]);
  console.log('PASS 019 isolated migration and staff privileges');
}
