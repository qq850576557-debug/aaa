// Development-only lab. Uses a NEW isolated DB on the existing local test cluster.
// Never run against ECS or point this harness at production.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { request, Agent } from 'node:https';
import pg from 'pg';
import { chromium, expect, type Page } from '@playwright/test';
import { newDeployment, url, nginx, identifier } from './shared';
import { cluster, grants, owner } from './admin';
import { smoke, afterRestart, backup, restoreCheck } from './ops';
process.loadEnvFile('.env.test.local');
const target = new URL(process.env.MIGRATION_DATABASE_URL!);
if (
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/chunmo_test' ||
  process.env.APP_ENV !== 'test'
)
  throw Error('Dedicated existing local test cluster required');
const root = mkdtempSync(join(tmpdir(), 'chunmo-native-lab-')),
  conf = join(root, 'config'),
  tls = join(root, 'tls'),
  state = join(root, 'state'),
  backups = join(root, 'backups');
for (const p of [conf, tls, state, backups]) mkdirSync(p, { mode: 0o700 });
const suffix = randomBytes(4).toString('hex'),
  c = newDeployment(),
  password = randomBytes(24).toString('hex'),
  privateKey = randomBytes(32).toString('hex');
c.db = `chunmo_lab_${suffix}_test`;
c.port = Number(target.port);
for (const [key, r] of Object.entries(c.roles)) r.name = `cm_lab_${suffix}_${key}`;
writeFileSync(join(conf, 'control.json'), JSON.stringify(c), { mode: 0o600 });
writeFileSync(join(conf, 'backup.key'), randomBytes(32).toString('hex'), { mode: 0o600 });
writeFileSync(join(conf, 'owner.env'), `OWNER_LOGIN=lab_owner\nOWNER_PASSWORD=${password}\n`, {
  mode: 0o600,
});
const publicMode = process.env.CHUNMO_LAB_PUBLIC === '1';
const origin = publicMode ? 'https://127.0.0.2:15001' : 'https://127.0.0.1:18443',
  ca = join(tls, 'ca.crt');
const runtime = (database = c.db) => ({
  APP_ENV: 'production',
  APP_ORIGIN: origin,
  API_PORT: '4006',
  DATABASE_URL: url(c, 'app', database),
  PRIVATE_DATABASE_URL: url(c, 'private', database),
  PRIVATE_DATA_KEY: privateKey,
  TZ: 'Asia/Shanghai',
});
writeFileSync(
  join(conf, 'runtime.env'),
  Object.entries(runtime())
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
const tools = process.env.CHUNMO_LAB_TOOLS ?? '/tmp/chunmo-native-tools/root',
  nginxBin = tools + '/usr/sbin/nginx',
  dump = tools + '/usr/lib/postgresql/17/bin/pg_dump',
  restore = tools + '/usr/lib/postgresql/17/bin/pg_restore';
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await admin.connect();
let api: ChildProcess | undefined,
  web: ChildProcess | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function stop(p: ChildProcess | undefined) {
  if (!p || p.exitCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    p.kill('SIGTERM');
  });
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function health() {
  const agent = new Agent({ ca: readFileSync(ca) });
  try {
    for (let i = 0; i < 40; i++) {
      const ok = await new Promise<boolean>((done) => {
        const r = request(origin + '/api/health', { agent }, (res) => {
          res.resume();
          done(res.statusCode === 200);
        });
        r.on('error', () => done(false));
        r.setTimeout(1500, () => r.destroy());
        r.end();
      });
      if (ok) return;
      await pause(250);
    }
    throw Error('HTTPS lab did not become healthy');
  } finally {
    agent.destroy();
  }
}
async function startApi(database = c.db) {
  api = spawn(process.execPath, ['dist-api/server.mjs'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, ...runtime(database) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout!.resume();
  api.stderr!.resume();
}
async function enter(page: Page, login: string) {
  await page.goto(origin);
  await page.getByRole('button', { name: '连接云空间', exact: true }).click();
  const f = page.getByRole('dialog', { name: '云端账号与工作空间', exact: true });
  await f.getByLabel('登录账号', { exact: true }).fill(login);
  await f.getByLabel('登录密码', { exact: true }).fill(password);
  await f.getByRole('button', { name: '登录云端', exact: true }).click();
  return f;
}
try {
  await cluster(admin, c);
  await cluster(admin, c);
  await grants(c);
  await grants(c);
  await owner(c, 'lab_owner', password);
  await owner(c, 'lab_owner', password);
  console.log(
    'PASS native provisioning/migrations/grants/bootstrap repeat without password rotation or data deletion.',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-subj',
      '/CN=Chunmo isolated lab CA',
      '-keyout',
      join(tls, 'ca.key'),
      '-out',
      ca,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(tls, 'server.key'),
      '-out',
      join(tls, 'server.csr'),
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(
    join(tls, 'server.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n',
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      join(tls, 'server.csr'),
      '-CA',
      ca,
      '-CAkey',
      join(tls, 'ca.key'),
      '-CAcreateserial',
      '-days',
      '2',
      '-sha256',
      '-extfile',
      join(tls, 'server.ext'),
      '-out',
      join(tls, 'server.crt'),
    ],
    { stdio: 'ignore' },
  );
  const external = publicMode
    ? { origin, certificate: join(tls, 'server.crt'), key: join(tls, 'server.key') }
    : undefined;
  if (external)
    writeFileSync(join(conf, 'public-https.json'), JSON.stringify(external), { mode: 0o600 });
  writeFileSync(join(root, 'nginx.conf'), nginx(process.cwd(), tls, state, 18443, 4006, external));
  execFileSync(nginxBin, ['-t', '-p', root + '/', '-c', join(root, 'nginx.conf')], {
    stdio: 'pipe',
  });
  web = spawn(nginxBin, ['-p', root + '/', '-c', join(root, 'nginx.conf'), '-g', 'daemon off;'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  web.stderr!.resume();
  await startApi();
  await health();
  await smoke(conf, origin, ca);
  await stop(api);
  await startApi();
  await health();
  await afterRestart(conf, origin, ca);
  const pub = execFileSync('openssl', [
    'x509',
    '-in',
    join(tls, 'server.crt'),
    '-pubkey',
    '-noout',
  ]);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pub });
  const pin = createHash('sha256').update(der).digest('base64');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/usr/bin/chromium',
    args: ['--ignore-certificate-errors-spki-list=' + pin],
  });
  // Trust only this generated certificate in the isolated browser. No blanket ignoreHTTPSErrors.
  const ctxA = await browser.newContext(),
    ctxB = await browser.newContext(),
    a = await ctxA.newPage(),
    b = await ctxB.newPage();
  const ownerForm = await enter(a, 'lab_owner');
  await ownerForm.getByText('创建普通员工账号', { exact: true }).click();
  await ownerForm.getByLabel('新员工登录名', { exact: true }).fill('lab_staff');
  await ownerForm.getByLabel('初始密码', { exact: true }).fill(password);
  await ownerForm.getByRole('button', { name: '创建员工', exact: true }).click();
  await expect(ownerForm).toContainText('普通员工账号已创建');
  await ownerForm.getByRole('button', { name: '进入云空间', exact: true }).click();
  await expect(a.locator('.save-state')).toContainText('已保存');
  const staffForm = await enter(b, 'lab_staff');
  await staffForm.getByRole('button', { name: '进入云空间', exact: true }).click();
  await expect(b.locator('.save-state')).toContainText('已保存');
  for (const ctx of [ctxA, ctxB]) {
    const cookies = await ctx.cookies(origin + '/api/workspace');
    assert.ok(
      cookies.some((cookie) => cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict'),
    );
  }
  const hostileStatus = await new Promise<number | undefined>((done, reject) => {
    const agent = new Agent({ ca: readFileSync(ca) });
    const req = request(
      origin + '/api/auth/logout',
      {
        agent,
        method: 'POST',
        headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          agent.destroy();
          done(res.statusCode);
        });
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(hostileStatus, 403);
  console.log('PASS HTTPS browser Secure/HttpOnly/SameSite cookies and hostile Origin rejection.');
  await a.getByRole('button', { name: '新建项目', exact: true }).click();
  const f = a.getByRole('dialog', { name: '新建项目', exact: true });
  await f.getByLabel('项目名称', { exact: true }).fill('原生HTTPS双会话验收');
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect(b.locator('.project-info h2')).toHaveText('原生HTTPS双会话验收', { timeout: 12000 });
  await b.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const edit = b.getByRole('dialog', { name: '编辑项目', exact: true });
  await edit.getByLabel('项目名称', { exact: true }).fill('员工经原生HTTPS同步');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(a.locator('.project-info h2')).toHaveText('员工经原生HTTPS同步', { timeout: 12000 });
  await stop(api);
  await startApi();
  await health();
  await a.reload();
  await expect(a.locator('.project-info h2')).toHaveText('员工经原生HTTPS同步');
  console.log(
    'PASS built frontend + native Nginx HTTPS: owner creates employee, two browser sessions, bidirectional SSE and reload after API restart.',
  );
  const file = await backup(conf, backups, dump);
  const tampered = file + '.tampered',
    bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(tampered, bytes, { mode: 0o600 });
  const manifest = JSON.parse(readFileSync(file + '.json', 'utf8'));
  manifest.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(tampered + '.json', JSON.stringify(manifest), { mode: 0o600 });
  let created = false;
  await assert.rejects(
    restoreCheck(conf, tampered, restore, () => {
      created = true;
    }),
  );
  assert.equal(created, false);
  console.log('PASS tampered encrypted backup rejected before creating a restore database.');
  const restored = await restoreCheck(conf, file, restore, async (name, cfg) => {
    await admin.query(
      `CREATE DATABASE ${identifier(name)} OWNER ${identifier(cfg.roles.migrator.name)} TEMPLATE template0`,
    );
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`);
  });
  await grants({ ...c, db: restored });
  await stop(api);
  await startApi(restored);
  await health();
  await a.reload();
  await expect(a.locator('.project-info h2')).toHaveText('员工经原生HTTPS同步');
  console.log(
    'PASS restored database actually serves preserved accounts/sessions and project through HTTPS.',
  );
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({
      passed: true,
      database: c.db,
      restoredDatabase: restored,
      nativeNginx: true,
      twoBrowserSessions: true,
      apiRestart: true,
      encryptedBackup: true,
      restoreVerified: true,
    }),
    { mode: 0o600 },
  );
  console.log(
    'Lab PASS. Protected artifacts retained at ' +
      root +
      '; no ECS access or original local-data changes.',
  );
} finally {
  await browser?.close();
  await stop(api);
  await stop(web);
  await admin.end();
}
