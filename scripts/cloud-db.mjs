import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const mode = process.argv[2];
if (!['development', 'test'].includes(mode)) throw Error('Use development or test');
const path = `.env.${mode}.local`,
  name = `chunmo-b-${mode}`,
  port = mode === 'test' ? 55433 : 55432;
const run = (args, env = process.env) =>
  spawnSync(
    'docker',
    [
      `--host=${process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock'}`,
      ...args,
    ],
    {
      env: Object.fromEntries(
        Object.entries(env).filter(
          ([k]) =>
            ![
              'DOCKER_HOST',
              'DOCKER_CONTEXT',
              'DOCKER_TLS',
              'DOCKER_TLS_VERIFY',
              'DOCKER_CERT_PATH',
            ].includes(k),
        ),
      ),
      encoding: 'utf8',
    },
  );
const exists = run(['container', 'inspect', name]).status === 0;
if (exists && !existsSync(path))
  throw Error(
    'Container exists but config is missing; preserve it and recover credentials manually.',
  );
if (!exists && existsSync(path))
  throw Error('Config exists without container; preserve config and recover database manually.');
if (!exists) {
  const password = randomBytes(24).toString('hex');
  const r = run(
    [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'chunmo.environment=' + mode,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-e',
      'POSTGRES_USER',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB',
      '--mount',
      `type=volume,source=${name},target=/var/lib/postgresql/data`,
      'postgres:17-alpine',
    ],
    {
      ...process.env,
      POSTGRES_USER: 'chunmo',
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: `chunmo_${mode}`,
    },
  );
  if (r.status !== 0) throw Error('Could not create local PostgreSQL: ' + r.stderr);
  writeFileSync(
    path,
    `APP_ENV=${mode}\nDATABASE_URL=postgresql://chunmo:${password}@127.0.0.1:${port}/chunmo_${mode}\nAPP_ORIGIN=http://127.0.0.1:5173\nAPI_PORT=${mode === 'test' ? 4001 : 4000}\nPRIVATE_DATA_KEY=${randomBytes(32).toString('hex')}\n`,
    { mode: 0o600 },
  );
} else {
  const r = run(['start', name]);
  if (r.status) throw Error('Could not start local container');
}
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (run(['exec', name, 'pg_isready', '-U', 'chunmo', '-d', `chunmo_${mode}`]).status === 0) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready)
  throw Error('Local PostgreSQL is not ready; configuration and volume preserved. Retry later.');
console.log(
  `Local ${mode} PostgreSQL configured. Credentials written to ignored ${path}; no credentials printed.`,
);
