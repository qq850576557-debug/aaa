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
import { PNG } from 'pngjs';
import { chromium, expect, type Page } from '@playwright/test';
import { newDeployment, url, nginx, identifier, publicHTTPS } from './shared';
import { preparePrivateCA } from './public';
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
const privateCAMode = process.env.CHUNMO_LAB_PRIVATE_CA === '1';
const publicMode = process.env.CHUNMO_LAB_PUBLIC === '1' || privateCAMode;
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
  await expect(page.locator('.brand-login')).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.setItem('chunmo-space', 'local');
    localStorage.setItem('VITE_ALLOW_LOCAL', 'true');
  });
  await page.reload();
  await expect(page.locator('.brand-login')).toBeVisible();
  await expect(page.locator('.main-shell')).toHaveCount(0);
  await expect(page.locator('.brand-login img')).toBeVisible();
  await page.screenshot({ path: '/tmp/chunmo-v11-login.png' });
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const f = page.getByRole('dialog', { name: '账号管理', exact: true });
  await expect(f).toContainText(login);
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
  const caConfig = join(tls, 'lab-ca.cnf');
  writeFileSync(
    caConfig,
    `[req]
prompt=no
distinguished_name=dn
[dn]
CN=Chunmo isolated lab CA
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
`,
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
      '4',
      '-subj',
      '/CN=Chunmo isolated lab CA',
      '-keyout',
      join(tls, 'ca.key'),
      '-out',
      ca,
      '-config',
      caConfig,
      '-extensions',
      'ca',
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
  let external = publicMode
    ? { origin, certificate: join(tls, 'server.crt'), key: join(tls, 'server.key') }
    : undefined;
  if (privateCAMode) {
    const existing = ['ca.key', 'ca.crt', 'server.key', 'server.crt'].map((name) =>
      readFileSync(join(tls, name)),
    );
    const bundle = preparePrivateCA(conf, tls, process.cwd(), state, origin);
    external = publicHTTPS(JSON.parse(readFileSync(join(bundle, 'public-https.json'), 'utf8')));
    for (const [index, name] of ['ca.key', 'ca.crt', 'server.key', 'server.crt'].entries())
      assert.deepEqual(readFileSync(join(tls, name)), existing[index]);
    console.log(
      'PASS private CA issues a distinct IP-SAN leaf; CA key/certificate and localhost pair remain byte-identical.',
    );
  }
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
    external?.certificate ?? join(tls, 'server.crt'),
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
  await ownerForm.getByRole('tab', { name: '账号通讯录', exact: true }).click();
  await ownerForm.getByText('创建普通员工账号', { exact: true }).click();
  await ownerForm.getByLabel('新员工登录名', { exact: true }).fill('lab_staff');
  await ownerForm.getByLabel('初始密码', { exact: true }).fill(password);
  await ownerForm.getByRole('button', { name: '创建员工', exact: true }).click();
  await expect(ownerForm).toContainText('普通员工账号已创建');
  await ownerForm.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(a.locator('.save-state')).toContainText('已保存');
  const staffForm = await enter(b, 'lab_staff');
  await staffForm.getByRole('button', { name: '关闭', exact: true }).click();
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
  await expect(b.locator('.current-project-name')).toHaveText('原生HTTPS双会话验收', {
    timeout: 12000,
  });
  await b.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const edit = b.getByRole('dialog', { name: '编辑项目', exact: true });
  await edit.getByLabel('项目名称', { exact: true }).fill('员工经原生HTTPS同步');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(a.locator('.current-project-name')).toHaveText('员工经原生HTTPS同步', {
    timeout: 12000,
  });
  await stop(api);
  await startApi();
  await health();
  await a.reload();
  await expect(a.locator('.current-project-name')).toHaveText('员工经原生HTTPS同步');
  console.log(
    'PASS built frontend + native Nginx HTTPS: owner creates employee, two browser sessions, bidirectional SSE and reload after API restart.',
  );
  // Exercise the new identity flow through the actual production HTTPS build.
  await a.reload();
  await expect(b.locator('.save-state')).toContainText('已保存');
  await a.getByRole('button', { name: '账号管理', exact: true }).click();
  const renamePanel = a.getByRole('dialog', { name: '账号管理', exact: true });
  await renamePanel.getByText('修改登录账号', { exact: true }).click();
  await renamePanel.getByLabel('新登录账号', { exact: true }).fill('春茉负责人');
  await renamePanel.getByRole('button', { name: '继续修改登录账号' }).click();
  const renameConfirm = a.getByRole('dialog', { name: '确认修改登录账号', exact: true });
  await renameConfirm.getByLabel('当前登录密码').fill(password);
  await renameConfirm.getByRole('button', { name: '确认修改并退出登录' }).click();
  await expect(a.locator('.brand-login')).toBeVisible();
  await expect(b.locator('.current-project-name')).toHaveText('员工经原生HTTPS同步');
  const renamedPanel = await enter(a, '春茉负责人');
  await renamedPanel.getByRole('button', { name: '关闭', exact: true }).click();
  const renamedPolicy = await a.evaluate(async () =>
    (await fetch('/api/auth/login-policy')).json(),
  );
  assert.equal(renamedPolicy.canChange, false);
  console.log(
    'PASS production HTTPS Chinese login rename, full session revocation and 90-day policy.',
  );
  const avatarPNG = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const avatarCode = await b.evaluate(
    async (image) => {
      const session = await (await fetch('/api/auth/session')).json();
      return (
        await fetch('/api/auth/avatar', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
          body: JSON.stringify({ image }),
        })
      ).status;
    },
    'data:image/png;base64,' + avatarPNG.toString('base64'),
  );
  assert.equal(avatarCode, 200);
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
  await expect(a.locator('.current-project-name')).toHaveText('员工经原生HTTPS同步');
  await b.reload();
  await expect(b.locator('.current-project-name')).toHaveText('员工经原生HTTPS同步');
  const restoredPolicy = await a.evaluate(async () =>
    (await fetch('/api/auth/login-policy')).json(),
  );
  assert.equal(restoredPolicy.login, '春茉负责人');
  assert.equal(restoredPolicy.canChange, false);
  assert.equal(restoredPolicy.nextAllowedAt, renamedPolicy.nextAllowedAt);
  const restoredAvatar = await b.evaluate(async () => {
    const s = await (await fetch('/api/auth/session')).json();
    const r = await fetch('/api/accounts/' + s.user.id + '/avatar');
    return { status: r.status, bytes: Array.from(new Uint8Array(await r.arrayBuffer())) };
  });
  assert.equal(restoredAvatar.status, 200);
  assert.deepEqual(Buffer.from(restoredAvatar.bytes), avatarPNG);
  console.log('PASS avatar PNG persists through encrypted database backup and isolated restore.');
  console.log(
    'PASS restored database serves preserved sessions/project and retains the exact Chinese login cooldown.',
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
