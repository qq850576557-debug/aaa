import pg from 'pg';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  existsSync,
  readdirSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { request as httpsRequest, Agent } from 'node:https';
import argon2 from 'argon2';
import { config, initConfig, url, identifier, magic, hba, nginx, type Deployment } from './shared';
import { createWorkspace } from '../../server/store';
import { newProject, defaultTrades, emptyData, prepareWorkspace } from '../../src/lib/model';
const hashFile = async (file: string) => {
  const h = createHash('sha256');
  for await (const part of createReadStream(file)) h.update(part);
  return h.digest('hex');
};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const connection = async (
  c: Deployment,
  role: keyof Deployment['roles'] = 'migrator',
  db?: string,
) => {
  const p = new pg.Client({ connectionString: url(c, role, db) });
  await p.connect();
  return p;
};
function pgEnv(c: Deployment, role: keyof Deployment['roles']) {
  const r = c.roles[role];
  return {
    ...process.env,
    PGHOST: c.host,
    PGPORT: String(c.port),
    PGUSER: r.name,
    PGPASSWORD: r.password,
    PGDATABASE: c.db,
  };
}
function peer(op: string, c: Deployment, database?: string) {
  const socket = process.env.PG_ADMIN_SOCKET;
  if (!socket?.startsWith('/')) throw Error('Local PostgreSQL socket not configured');
  execFileSync(
    'runuser',
    ['-u', 'postgres', '--', process.execPath, resolve('dist-deploy/admin.mjs'), op],
    { input: JSON.stringify({ config: c, socket, database }), stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
export async function backup(configDir: string, directory: string, dump: string) {
  const c = config(configDir),
    files = readdirSync(directory).filter(
      (x) =>
        /^backup-[a-f0-9]{32}-[0-9TZ-]+-[a-f0-9]{8}\.cmbackup$/.test(x) &&
        x.startsWith('backup-' + c.id + '-'),
    );
  if (files.length >= 14)
    throw Error(
      'Backup quota reached (14): export verified copies off-site and review retention; nothing deleted',
    );
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize < 1024 ** 3)
    throw Error('Backup requires 1 GiB free space; nothing deleted');
  const key = Buffer.from(readFileSync(join(configDir, 'backup.key'), 'utf8').trim(), 'hex');
  if (key.length !== 32) throw Error('Invalid backup key');
  const file = join(
      directory,
      `backup-${c.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.cmbackup`,
    ),
    partial = file + '.partial';
  const db = await connection(c, 'backup');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await db.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const names = (
        await db.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((r) => r.tablename as string),
      counts: Record<string, number> = {};
    for (const name of names)
      counts[name] = Number(
        (await db.query(`SELECT count(*) AS n FROM public.${identifier(name)}`)).rows[0].n,
      );
    const iv = randomBytes(12),
      header = Buffer.concat([magic, iv]),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    writeFileSync(partial, header, { flag: 'wx', mode: 0o600 });
    child = spawn(dump, ['--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot], {
      env: pgEnv(c, 'backup'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const done = new Promise<void>((ok, no) => {
      child!.once('error', no);
      child!.once('close', (code) =>
        code === 0 ? ok() : no(Error('pg_dump failed; protected output not published')),
      );
    });
    child.stderr!.resume();
    await Promise.all([
      pipeline(child.stdout!, cipher, createWriteStream(partial, { flags: 'a', mode: 0o600 })),
      done,
    ]);
    appendFileSync(partial, cipher.getAuthTag());
    await db.query('COMMIT');
    renameSync(partial, file);
    writeFileSync(
      file + '.json',
      JSON.stringify({
        version: 1,
        deployment: c.id,
        database: c.db,
        created: new Date().toISOString(),
        sha256: await hashFile(file),
        counts,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    console.log('Encrypted consistent database backup complete: ' + file);
    return file;
  } catch (e) {
    child?.kill('SIGTERM');
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}
export async function restoreCheck(
  configDir: string,
  archive: string,
  restore: string,
  createDatabase: (name: string, c: Deployment) => void | Promise<void>,
) {
  const c = config(configDir),
    manifest = JSON.parse(readFileSync(archive + '.json', 'utf8'));
  if (
    manifest.deployment !== c.id ||
    manifest.database !== c.db ||
    manifest.sha256 !== (await hashFile(archive))
  )
    throw Error('Backup identity/checksum mismatch');
  const key = Buffer.from(readFileSync(join(configDir, 'backup.key'), 'utf8').trim(), 'hex'),
    size = statSync(archive).size,
    header = Buffer.alloc(magic.length + 12),
    tag = Buffer.alloc(16),
    fd = openSync(archive, 'r');
  try {
    readSync(fd, header, 0, header.length, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (size < header.length + 16 || !header.subarray(0, magic.length).equals(magic))
    throw Error('Invalid archive format');
  const d = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
  d.setAAD(header);
  d.setAuthTag(tag);
  const plain = archive + '.verify-' + randomBytes(4).toString('hex');
  try {
    // Authenticate the whole file before creating a database or sending any SQL to pg_restore.
    await pipeline(
      createReadStream(archive, { start: header.length, end: size - 17 }),
      d,
      createWriteStream(plain, { flags: 'wx', mode: 0o600 }),
    );
    const target =
      'chunmo_restorecheck_' +
      new Date().toISOString().replace(/\D/g, '').slice(0, 14) +
      '_' +
      randomBytes(4).toString('hex');
    await createDatabase(target, c);
    const env = { ...pgEnv(c, 'migrator'), PGDATABASE: target };
    const child = spawn(
      restore,
      ['--dbname=' + target, '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'],
      { env, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let restoreError = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n'))
        if (line.startsWith('pg_restore: error:') && restoreError.length < 240)
          restoreError += line.replace(/"[^"]*"|'[^']*'/g, '[redacted]').slice(0, 200);
    });
    const done = new Promise<void>((ok, no) => {
      child.once('error', no);
      child.once('close', (code) =>
        code === 0
          ? ok()
          : no(Error('Isolated restore failed; source database untouched; ' + restoreError)),
      );
    });
    child.stderr!.resume();
    await Promise.all([pipeline(createReadStream(plain), child.stdin!), done]);
    const db = await connection(c, 'migrator', target);
    try {
      for (const [name, count] of Object.entries(manifest.counts))
        if (
          Number(
            (await db.query(`SELECT count(*) AS n FROM public.${identifier(name)}`)).rows[0].n,
          ) !== count
        )
          throw Error('Restored table count mismatch: ' + name);
      // Verify private-data key and GCM tags without displaying personal values.
      const envFile = readFileSync(join(configDir, 'runtime.env'), 'utf8'),
        privateKey = envFile.match(/^PRIVATE_DATA_KEY=([a-f0-9]{64})$/m)?.[1];
      if (!privateKey) throw Error('Private-data key missing');
      for (const r of (await db.query('SELECT sealed FROM person_private')).rows) {
        const s = r.sealed,
          dec = createDecipheriv(
            'aes-256-gcm',
            Buffer.from(privateKey, 'hex'),
            Buffer.from(s.iv, 'hex'),
          );
        dec.setAuthTag(Buffer.from(s.tag, 'hex'));
        dec.update(Buffer.from(s.ciphertext, 'hex'));
        dec.final();
      }
    } finally {
      await db.end();
    }
    writeFileSync(
      archive + '.restore-verified.json',
      JSON.stringify({
        at: new Date().toISOString(),
        database: target,
        countsVerified: true,
        privateKeyVerified: true,
      }),
      { mode: 0o600 },
    );
    console.log(
      'PASS isolated restore, table counts, constraints and private-key authentication: ' +
        target +
        ' (retained; source database untouched)',
    );
    return target;
  } finally {
    if (existsSync(plain)) unlinkSync(plain);
  }
}
type Session = { cookie: string; csrf: string };
function http(origin: string, ca: string) {
  const agent = new Agent({ ca: readFileSync(ca), keepAlive: true });
  const call = (path: string, method = 'GET', body?: unknown, s?: Session) =>
    new Promise<{ status: number; value: any; cookie: string }>((ok, no) => {
      const data = body === undefined ? undefined : JSON.stringify(body),
        r = httpsRequest(
          origin + '/api' + path,
          {
            method,
            agent,
            headers: {
              Origin: origin,
              ...(data
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                : {}),
              ...(s ? { Cookie: s.cookie, 'X-CSRF-Token': s.csrf } : {}),
            },
          },
          (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () => {
              try {
                ok({
                  status: res.statusCode!,
                  value: JSON.parse(raw),
                  cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '',
                });
              } catch {
                no(Error('Invalid HTTPS API response'));
              }
            });
          },
        );
      r.on('error', no);
      r.setTimeout(12000, () => r.destroy(Error('HTTPS timeout')));
      if (data) r.write(data);
      r.end();
    });
  return { call, agent };
}
const need = (condition: unknown, label: string) => {
  if (!condition) throw Error('Deployment check failed: ' + label);
};
export async function cleanup(configDir: string) {
  const path = join(configDir, 'probe-pending.json');
  if (!existsSync(path)) return;
  const p = JSON.parse(readFileSync(path, 'utf8')),
    db = await connection(config(configDir));
  try {
    const q = await db.query(
      "SELECT id FROM account WHERE workspace_id=$1 AND login LIKE 'deploy_probe_%'",
      [p.workspace],
    );
    if (q.rowCount !== 2) throw Error('Unexpected probe ownership; refusing cleanup');
    await db.query('BEGIN');
    await db.query(
      'DELETE FROM auth_session WHERE account_id IN(SELECT id FROM account WHERE workspace_id=$1)',
      [p.workspace],
    );
    await db.query('UPDATE account SET active=false WHERE workspace_id=$1', [p.workspace]);
    await db.query('COMMIT');
    unlinkSync(path);
  } finally {
    await db.end();
  }
}
export async function smoke(configDir: string, origin: string, ca: string) {
  await cleanup(configDir);
  const c = config(configDir),
    db = await connection(c),
    suffix = randomBytes(8).toString('hex'),
    login = 'deploy_probe_owner_' + suffix,
    employee = 'deploy_probe_staff_' + suffix,
    password = randomBytes(24).toString('hex');
  let workspace = '';
  const { call, agent } = http(origin, ca);
  try {
    await db.query('BEGIN');
    const pwd = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    const ids = await createWorkspace(db, login, pwd, '部署隔离验收');
    workspace = ids.workspaceId;
    await db.query(
      "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES($1,$2,$3,$4,'employee')",
      [randomUUID(), workspace, employee, pwd],
    );
    await db.query('COMMIT');
    writeFileSync(join(configDir, 'probe-pending.json'), JSON.stringify({ workspace }), {
      mode: 0o600,
    });
    const signIn = async (name: string) => {
      const r = await call('/auth/login', 'POST', { login: name, password });
      need(r.status === 200 && r.cookie, 'login');
      const session = await call('/auth/session', 'GET', undefined, { cookie: r.cookie, csrf: '' });
      need(session.status === 200, 'session');
      return { cookie: r.cookie, csrf: session.value.csrf };
    };
    const a = await signIn(login),
      b = await signIn(employee);
    need((await call('/workspace')).status === 401, 'anonymous access');
    need(
      (await call('/accounts', 'POST', { login: 'forbidden_' + suffix, password }, b)).status ===
        403,
      'employee account management denial',
    );
    const data = emptyData(),
      p = { ...newProject(), name: '部署隔离测试项目' };
    data.projects = [p];
    data.trades = defaultTrades(p.id);
    data.tasks = [
      {
        id: randomUUID(),
        projectId: p.id,
        tradeId: data.trades[0].id,
        name: '验收施工段',
        start: p.start,
        end: p.end,
        owner: '',
        notes: '',
        status: '未开始',
      },
    ];
    data.people = [
      {
        id: randomUUID(),
        name: '验收合成人员',
        role: '施工人员',
        trade: '',
        notes: '',
        active: true,
      },
    ];
    data.trades[0].staffIds = [data.people[0].id];
    const updated = await call(
      '/workspace',
      'PUT',
      { revision: 0, data: prepareWorkspace(data) },
      a,
    );
    need(updated.status === 200, 'persist complete graph');
    const state = await call('/workspace', 'GET', undefined, b);
    need(state.value.data.projects[0]?.id === p.id, 'second account sees update');
    const privatePath = '/people/' + data.people[0].id + '/private',
      phone = '+8613800000000';
    need(
      (await call(privatePath, 'PUT', { phone, birthDate: '1990-01-01' }, a)).status === 200,
      'owner private API',
    );
    need(
      (await call(privatePath, 'GET', undefined, b)).status === 403,
      'employee private API denial',
    );
    need(
      !JSON.stringify((await call('/export', 'GET', undefined, b)).value).includes(phone),
      'export redaction boundary',
    );
    const races = await Promise.all([
      call('/workspace', 'PUT', { revision: 1, data: state.value.data }, a),
      call('/workspace', 'PUT', { revision: 1, data: state.value.data }, b),
    ]);
    need(
      races
        .map((r) => r.status)
        .sort()
        .join(',') === '200,409',
      'concurrent CAS',
    );
    // Real SSE through Nginx: only revision metadata, no private values.
    await new Promise<void>((ok, no) => {
      let complete = false;
      const req = httpsRequest(
        origin + '/api/events',
        { agent, headers: { Cookie: b.cookie } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
            if (text.includes('event: revision')) {
              try {
                need(!text.includes(phone) && text.includes('"revision":2'), 'SSE revision');
                complete = true;
                ok();
              } catch (e) {
                no(e);
              }
              req.destroy();
            }
          });
        },
      );
      req.on('error', (e) => {
        if (!complete) no(e);
      });
      req.setTimeout(8000, () => req.destroy(Error('SSE timeout')));
      req.end();
    });
    need((await call('/auth/logout', 'POST', {}, b)).status === 200, 'logout');
    need((await call('/workspace', 'GET', undefined, b)).status === 401, 'revocation');
    const saved = (await call('/workspace', 'GET', undefined, a)).value;
    writeFileSync(
      join(configDir, 'probe-pending.json'),
      JSON.stringify({ workspace, session: a, hash: digest(saved.data), revision: saved.revision }),
      { mode: 0o600 },
    );
    console.log(
      'PASS TLS, owner/employee authentication, privacy, export, CAS, SSE and logout; restart verification pending.',
    );
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    if (workspace) await cleanup(configDir).catch(() => {});
    throw e;
  } finally {
    agent.destroy();
    await db.end();
  }
}
export async function afterRestart(configDir: string, origin: string, ca: string) {
  const p = JSON.parse(readFileSync(join(configDir, 'probe-pending.json'), 'utf8')),
    { call, agent } = http(origin, ca);
  try {
    const r = await call('/workspace', 'GET', undefined, p.session);
    need(
      r.status === 200 && r.value.revision === p.revision && digest(r.value.data) === p.hash,
      'state and session survive restart',
    );
    await cleanup(configDir);
    writeFileSync(
      join(configDir, 'verification.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        passed: true,
        checks: [
          'TLS',
          'owner',
          'employee',
          'private-API',
          'export',
          'CAS',
          'SSE',
          'logout',
          'restart-persistence',
        ],
        probeAccountsDisabled: true,
      }),
      { mode: 0o600 },
    );
    console.log('PASS restart persistence; isolated probe accounts revoked.');
  } finally {
    agent.destroy();
  }
}
async function main() {
  const [op, path, a, b] = process.argv.slice(2);
  if (op === 'config') initConfig(path);
  else if (op === 'cluster-input')
    process.stdout.write(
      JSON.stringify({ config: config(path), socket: process.env.PG_ADMIN_SOCKET }),
    );
  else if (op === 'hba') {
    const old = readFileSync(a, 'utf8'),
      next = hba(old, config(path).db);
    if (next !== old) {
      if (!existsSync(join(path, 'pg_hba.before')))
        writeFileSync(join(path, 'pg_hba.before'), old, { mode: 0o600 });
      const tmp = a + '.chunmo-new';
      writeFileSync(tmp, next, { mode: statSync(a).mode, flag: 'wx' });
      const s = statSync(a);
      const { chownSync, chmodSync } = await import('node:fs');
      chownSync(tmp, s.uid, s.gid);
      chmodSync(tmp, s.mode & 0o777);
      renameSync(tmp, a);
    }
  } else if (op === 'nginx') process.stdout.write(nginx(path, a, b));
  else if (op === 'backup') await backup(path, a, b);
  else if (op === 'restore-check')
    await restoreCheck(path, a, b, (name, c) => peer('restore-db', c, name));
  else if (op === 'smoke') await smoke(path, a, b);
  else if (op === 'after-restart') await afterRestart(path, a, b);
  else if (op === 'cleanup') await cleanup(path);
  else throw Error('Unsupported operation');
}
if (process.argv[1]?.endsWith('/ops.mjs') || process.argv[1]?.endsWith('/ops.ts'))
  main().catch((error: unknown) => {
    const e = error as { message?: string; code?: string };
    const safe = [
      'Deployment check failed:',
      'Backup quota reached',
      'Backup requires',
      'Backup identity/checksum mismatch',
      'Invalid archive format',
      'Unsupported state',
      'Current',
      'Partial config:',
      'Invalid retained keys:',
      'Isolated restore failed;',
    ];
    const detail =
      e.message && safe.some((x) => e.message!.startsWith(x))
        ? e.message.slice(0, 240)
        : /^\w{2,24}$/.test(e.code ?? '')
          ? 'code=' + e.code
          : 'review protected config, ownership, HBA, TLS and service logs';
    console.error('Native deployment operation failed; data retained; ' + detail);
    process.exitCode = 1;
  });
