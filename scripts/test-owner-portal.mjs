import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const name = 'chunmo-owner-auth-' + randomBytes(6).toString('hex');
const db = 'chunmo_owner_auth_test';
const admin = randomBytes(24).toString('hex');
const staff = randomBytes(24).toString('hex');
const runtime = randomBytes(24).toString('hex');
const localDocker =
  process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

function docker(args, env = process.env, input) {
  const result = spawnSync('docker', ['--host=' + localDocker, ...args], {
    encoding: 'utf8',
    env,
    input,
  });
  if (result.error || result.status !== 0) throw Error(result.stderr || String(result.error));
  return result.stdout.trim();
}

docker(
  [
    'run',
    '--rm',
    '--pull=never',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB=' + db,
    'postgres:17-alpine',
  ],
  { ...process.env, POSTGRES_PASSWORD: admin },
);
try {
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
  if (!/^\d+$/.test(port)) throw Error('Expected local test database port');
  for (let attempt = 0; ; attempt++) {
    try {
      docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', db]);
      break;
    } catch (error) {
      if (attempt >= 40) throw error;
      await setTimeout(250);
    }
  }
  const url = (user, secret) =>
    'postgresql://' + user + ':' + secret + '@127.0.0.1:' + port + '/' + db;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', 'server/owner-portal.test.ts'],
    {
      env: {
        ...process.env,
        APP_ENV: 'test',
        APP_ORIGIN: 'http://127.0.0.1:5173',
        MIGRATION_DATABASE_URL: url('postgres', admin),
        DATABASE_URL: url('owner_staff', staff),
        PRIVATE_DATABASE_URL: url('owner_private', randomBytes(24).toString('hex')),
        PRIVATE_DATA_KEY: randomBytes(32).toString('hex'),
        CHUNMO_OWNER_DATABASE_URL: url('owner_runtime', runtime),
        CHUNMO_OWNER_DATA_KEY: randomBytes(32).toString('hex'),
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && process.env.CHUNMO_OWNER_REHEARSE_RESTORE === '1') {
    const restored = 'chunmo_owner_restore_test';
    const sql = (database, statements) =>
      docker(
        [
          'exec',
          '-i',
          name,
          'psql',
          '-U',
          'postgres',
          '-qAt',
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          'staff_role=owner_staff',
          '-v',
          'owner_role=owner_runtime',
          '-v',
          'backup_role=owner_release_backup',
          '-d',
          database,
        ],
        process.env,
        statements,
      );
    const backupGrant = readFileSync('deploy/owner-release/backup-grants.sql', 'utf8');
    sql(
      db,
      `
      CREATE ROLE owner_release_backup LOGIN NOSUPERUSER NOINHERIT NOREPLICATION;
      CREATE ROLE owner_release_restore LOGIN NOSUPERUSER NOINHERIT NOREPLICATION;
      GRANT USAGE ON SCHEMA public TO owner_release_backup;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO owner_release_backup;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO owner_release_backup;
    `,
    );
    const dumpCommand = [
      'exec',
      name,
      'pg_dump',
      '-U',
      'owner_release_backup',
      '-Fc',
      '--no-owner',
      '--no-acl',
      '-f',
      '/tmp/owner-rehearsal.dump',
      db,
    ];
    const denied = spawnSync('docker', ['--host=' + localDocker, ...dumpCommand], {
      encoding: 'utf8',
    });
    if (denied.status === 0 || !/permission denied.*owner_portal/u.test(denied.stderr ?? ''))
      throw Error('Backup scope before the additional grant was not verified');
    sql(db, backupGrant);
    docker(dumpCommand);
    docker(['exec', name, 'createdb', '-U', 'postgres', '-O', 'owner_release_restore', restored]);
    docker([
      'exec',
      name,
      'pg_restore',
      '-U',
      'owner_release_restore',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      '-d',
      restored,
      '/tmp/owner-rehearsal.dump',
    ]);
    sql(
      restored,
      [
        'server/proposed/016_owner_identity_grants.sql',
        'server/proposed/017_owner_purchase_grants.sql',
        'deploy/owner-release/backup-grants.sql',
      ]
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n'),
    );
    const query = `SELECT json_build_array(
      (SELECT jsonb_object_agg(name,checksum) FROM schema_migration),
      (SELECT jsonb_object_agg(filename,sha256) FROM owner_portal.purchase_migration),
      (SELECT count(*) FROM purchase), (SELECT count(*) FROM work_record),
      (SELECT count(*) FROM owner_portal.member),
      (SELECT count(*) FROM owner_portal.project_grant),
      (SELECT count(*) FROM owner_portal.purchase_collaboration),
      (SELECT count(*) FROM owner_portal.purchase_event),
      has_function_privilege('owner_runtime','owner_portal.owner_purchases(text,text)','EXECUTE'),
      NOT has_table_privilege('owner_runtime','public.purchase','SELECT'),
      NOT has_table_privilege('owner_runtime','public.work_record','SELECT'),
      has_table_privilege('owner_release_backup','owner_portal.purchase_event','SELECT'),
      NOT has_table_privilege('owner_release_backup','owner_portal.purchase_event','INSERT'));`;
    const verify = (database) => sql(database, query);
    if (verify(db) !== verify(restored)) throw Error('Owner restore verification differs');
    const reportSql = spawnSync(
      'python3',
      [
        '-c',
        "import runpy; print(runpy.run_path('deploy/owner-release/preflight.py')['REPORT_SQL'])",
      ],
      { encoding: 'utf8' },
    );
    if (reportSql.status !== 0) throw Error('Could not load the production read-only query');
    const report = docker(
      [
        'exec',
        '-i',
        name,
        'psql',
        '-U',
        'postgres',
        '-qAt',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'staff=owner_staff',
        '-v',
        'owner=owner_runtime',
        '-d',
        restored,
      ],
      process.env,
      reportSql.stdout,
    )
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !report[0]?.ownerObjects?.purchase ||
      report[0]?.ownerRole?.canReadInternalRecords !== false ||
      !report[1]?.ownerPurchaseMigrations
    )
      throw Error('Production read-only query did not verify the restored schema');
    process.stdout.write(
      'PASS isolated backup and restore with migration hashes and owner permissions\n',
    );
  }
} finally {
  docker(['stop', name]);
}
