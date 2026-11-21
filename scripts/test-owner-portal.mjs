import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const name = 'chunmo-owner-auth-' + randomBytes(6).toString('hex');
const db = 'chunmo_owner_auth_test';
const admin = randomBytes(24).toString('hex');
const staff = randomBytes(24).toString('hex');
const runtime = randomBytes(24).toString('hex');
const localDocker =
  process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

function docker(args, env = process.env) {
  const result = spawnSync('docker', ['--host=' + localDocker, ...args], { encoding: 'utf8', env });
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
} finally {
  docker(['stop', name]);
}
