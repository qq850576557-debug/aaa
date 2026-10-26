import pg from 'pg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from './app';
import { pool, privatePool } from './db';
import { fixtureAccounts } from './test-fixtures';
import { config } from './config';
import { emptyData, newProject, defaultTrades, type Data } from '../src/lib/model';
import { migrate } from './migrate';
import { maintain } from './maintenance';
let server: Server, base: string;
before(async () => {
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await privatePool.end();
});
type Client = { cookie: string; csrf: string; user: any };
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  client?: Client,
  headers: Record<string, string> = {},
) {
  return fetch(base + '/api' + path, {
    method,
    headers: {
      Origin: config.APP_ORIGIN,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(login: string, password: string): Promise<Client> {
  const r = await request('/auth/login', 'POST', { login, password });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0],
    s = await request('/auth/session', 'GET', undefined, { cookie, csrf: '', user: null });
  const value = await s.json();
  return { cookie, csrf: value.csrf, user: value.user };
}
function data(): Data {
  const d = emptyData(),
    p = { ...newProject(), name: '真实数据库项目' };
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  d.people = [
    {
      id: randomUUID(),
      name: '测试施工员',
      role: '施工人员',
      trade: '水电',
      active: true,
      notes: '',
    },
  ];
  d.trades[0].staffIds = [d.people[0].id];
  d.tasks = [
    {
      id: randomUUID(),
      projectId: p.id,
      tradeId: d.trades[0].id,
      name: '真实施工段',
      start: p.start,
      end: p.end,
      owner: '',
      notes: '',
      status: '未开始',
    },
  ];
  d.purchases = [
    {
      id: randomUUID(),
      projectId: p.id,
      name: '材料',
      taskId: d.tasks[0].id,
      due: p.start,
      leadDays: 0,
      owner: '',
      notes: '',
      status: '待采购',
    },
  ];
  return d;
}
async function setup() {
  const f = await fixtureAccounts(),
    a = await login(f.login, f.password),
    b = await login(f.employee, f.password);
  return { f, a, b };
}
test('real authentication, cookie policy, CSRF, role escalation rejection, password reset and disabled-session revocation', async () => {
  const { f, a, b } = await setup();
  assert.equal((await request('/workspace')).status, 401);
  assert.equal(
    (await request('/accounts', 'POST', { login: 'intruder', password: f.password }, b)).status,
    403,
  );
  assert.equal(
    (
      await request('/workspace', 'PUT', { revision: 0, data: emptyData() }, a, {
        'X-CSRF-Token': 'wrong',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/workspace', 'PUT', { revision: 0, data: emptyData() }, a, {
        Origin: 'https://attacker.invalid',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/accounts',
        'POST',
        { login: 'forged_' + randomUUID(), password: f.password, role: 'owner' },
        a,
      )
    ).status,
    400,
  );
  const cookieResponse = await request('/auth/login', 'POST', {
    login: f.login,
    password: f.password,
  });
  assert.match(cookieResponse.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(cookieResponse.headers.get('set-cookie')!, /SameSite=Strict/);
  assert.equal(
    (await request('/accounts/' + f.employeeId, 'PATCH', { active: false }, a)).status,
    200,
  );
  assert.equal((await request('/auth/session', 'GET', undefined, b)).status, 401);
  assert.equal(
    (
      await request(
        '/accounts/' + f.employeeId,
        'PATCH',
        { active: true, password: f.password + 'x' },
        a,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request('/auth/login', 'POST', { login: f.employee, password: f.password })).status,
    401,
  );
  const newB = await login(f.employee, f.password + 'x');
  assert.equal((await request('/auth/logout', 'POST', {}, newB)).status, 200);
  assert.equal((await request('/workspace', 'GET', undefined, newB)).status, 401);
});
test('PostgreSQL relational persistence, trusted actors, CAS conflict and owner-only restore preserve graphs', async () => {
  const { a, b } = await setup(),
    d = data();
  let r = await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.revision, 1);
  const row = await pool.query('SELECT count(*)::int AS n FROM assignment WHERE workspace_id=$1', [
    a.user.workspaceId,
  ]);
  assert.equal(row.rows[0].n, 1);
  assert.equal(
    s.history.records.find((x: any) => x.scope === d.projects[0].id).actor,
    a.user.login,
  );
  const one = structuredClone(s.data);
  one.projects[0].name = '员工提交';
  r = await request('/workspace', 'PUT', { revision: 1, data: one }, b);
  assert.equal(r.status, 200);
  const second = await r.json();
  const stale = structuredClone(s.data);
  stale.projects[0].name = '不得覆盖';
  assert.equal((await request('/workspace', 'PUT', { revision: 1, data: stale }, a)).status, 409);
  const latest = await (await request('/workspace', 'GET', undefined, a)).json();
  assert.equal(latest.data.projects[0].name, '员工提交');
  const revision = second.history.records.findLast((x: any) => x.scope === d.projects[0].id);
  assert.equal(revision.actorId, b.user.id);
  assert.equal(
    (await request('/history/restore', 'POST', { revision: 2, id: revision.id }, b)).status,
    403,
  );
  r = await request('/history/restore', 'POST', { revision: 2, id: revision.id }, a);
  assert.equal(r.status, 200);
  const restored = await r.json();
  assert.equal(restored.data.projects[0].name, d.projects[0].name);
  assert.equal(restored.data.tasks.length, 1);
  assert.equal(restored.history.records.at(-1).action, '恢复');
  assert.ok(restored.history.records.some((x: any) => x.id === revision.id));
});
test('private data is owner-only, encrypted, inaccessible to normal SQL role and absent from exports/history/errors', async () => {
  const { a, b } = await setup(),
    d = data();
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  const id = d.people![0].id,
    phone = '+8613800000000';
  assert.equal(
    (await request(`/people/${id}/private`, 'PUT', { phone, birthDate: '1990-01-01' }, a)).status,
    200,
  );
  const read = await request(`/people/${id}/private`, 'GET', undefined, a);
  assert.equal((await read.json()).phone, phone);
  for (const method of ['GET', 'PUT']) {
    const r = await request(
      `/people/${id}/private`,
      method,
      method === 'PUT' ? { phone, birthDate: '' } : undefined,
      b,
    );
    assert.equal(r.status, 403);
    assert.ok(!(await r.text()).includes(phone));
  }
  for (const path of ['/workspace', '/export']) {
    const r = await request(path, 'GET', undefined, b),
      text = await r.text();
    assert.ok(!text.includes(phone));
    assert.ok(!text.includes('1990-01-01'));
    assert.ok(!text.includes('password_hash'));
  }
  await assert.rejects(pool.query('SELECT * FROM person_private'), (e: any) => e.code === '42501');
  const encrypted = await privatePool.query(
    'SELECT sealed FROM person_private WHERE workspace_id=$1',
    [a.user.workspaceId],
  );
  assert.ok(!JSON.stringify(encrypted.rows).includes(phone));
  const forged = structuredClone(d) as any;
  forged.people[0].phone = phone;
  const r = await request('/workspace', 'PUT', { revision: 1, data: forged }, b);
  assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes(phone));
  const events = await pool.query('SELECT action FROM audit_event WHERE workspace_id=$1', [
    a.user.workspaceId,
  ]);
  assert.ok(events.rows.some((x) => x.action === 'person.private.update'));
  const originalState = await (await request('/workspace', 'GET', undefined, a)).json();
  const removed = structuredClone(originalState.data);
  removed.people = [];
  for (const trade of removed.trades) trade.staffIds = [];
  const rejectedDelete = await request(
    '/workspace',
    'PUT',
    { revision: originalState.revision, data: removed },
    a,
  );
  assert.equal(rejectedDelete.status, 409);
  const stillSaved = await (await request('/workspace', 'GET', undefined, a)).json();
  assert.equal(stillSaved.revision, originalState.revision);
  assert.deepEqual(stillSaved.data, originalState.data);
  assert.equal(
    (await (await request(`/people/${id}/private`, 'GET', undefined, a)).json()).phone,
    phone,
  );
});
test('controlled import previews without writing, commits once, preserves IDs, validates conflicts and binds preview to actor/version', async () => {
  const { a, b } = await setup(),
    d = data();
  let r = await request('/import/preview', 'POST', { archive: d }, a);
  assert.equal(r.status, 200);
  const preview = await r.json();
  assert.equal(
    (await (await request('/workspace', 'GET', undefined, a)).json()).data.projects.length,
    0,
  );
  assert.equal(
    (await request('/import/commit', 'POST', { id: preview.id, revision: 0, confirm: true }, b))
      .status,
    403,
  );
  r = await request('/import/commit', 'POST', { id: preview.id, revision: 0, confirm: true }, a);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.projects[0].id, d.projects[0].id);
  r = await request('/import/preview', 'POST', { archive: d }, a);
  assert.equal((await r.json()).alreadyImported, true);
  const changed = structuredClone(d);
  changed.projects[0].name = '冲突';
  assert.equal((await request('/import/preview', 'POST', { archive: changed }, a)).status, 409);
  assert.equal(
    (await request('/import/preview', 'POST', { archive: { version: 99 } }, a)).status,
    400,
  );
  const other = data();
  const p = await (await request('/import/preview', 'POST', { archive: other }, a)).json();
  const current = await (await request('/workspace', 'GET', undefined, a)).json();
  current.data.projects[0].notes = '他人提交';
  assert.equal(
    (await request('/workspace', 'PUT', { revision: current.revision, data: current.data }, b))
      .status,
    200,
  );
  assert.equal(
    (await request('/import/commit', 'POST', { id: p.id, revision: p.revision, confirm: true }, a))
      .status,
    409,
  );
});
test('tenants cannot access each other, migrations are repeatable and SSE requires a real revocable session', async () => {
  const { a, b } = await setup(),
    other = await fixtureAccounts(),
    outsider = await login(other.login, other.password),
    d = data();
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  assert.equal(
    (await (await request('/workspace', 'GET', undefined, outsider)).json()).data.projects.length,
    0,
  );
  const sse = await request('/events', 'GET', undefined, b);
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type')!, /text\/event-stream/);
  const reader = sse.body!.getReader();
  let received = '';
  while (!received.includes('revision')) {
    const r = await reader.read();
    received += new TextDecoder().decode(r.value);
  }
  const current = await (await request('/workspace', 'GET', undefined, a)).json();
  current.data.projects[0].notes = '实时通知';
  await request('/workspace', 'PUT', { revision: 1, data: current.data }, a);
  while (!received.includes('"revision":2')) {
    const r = await reader.read();
    received += new TextDecoder().decode(r.value);
  }
  assert.ok(!received.includes('实时通知'));
  await request('/auth/logout', 'POST', {}, b);
  await reader.cancel();
  assert.equal((await request('/events', 'GET', undefined, b)).status, 401);
  await migrate(process.env.MIGRATION_DATABASE_URL!);
  await migrate(process.env.MIGRATION_DATABASE_URL!);
  const check = await (await request('/workspace', 'GET', undefined, a)).json();
  assert.equal(check.data.projects[0].notes, '实时通知');
});
test('database rejects dangling cross-project assignments atomically and reauthentication after HTTP server restart preserves data', async () => {
  const { a } = await setup(),
    d = data();
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  await assert.rejects(
    pool.query(
      "INSERT INTO assignment(workspace_id,scope_kind,scope_id,project_id,person_id) VALUES($1,'task','missing',$2,$3)",
      [a.user.workspaceId, d.projects[0].id, d.people![0].id],
    ),
    (e: any) => e.code === '23514',
  );
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await request('/auth/session', 'GET', undefined, a)).status, 200);
  assert.equal(
    (await (await request('/workspace', 'GET', undefined, a)).json()).data.tasks[0].id,
    d.tasks[0].id,
  );
});

test('simultaneous writes commit exactly one complete graph and reject the stale peer', async () => {
  const { a, b } = await setup(),
    d = data();
  const first = await (await request('/workspace', 'PUT', { revision: 0, data: d }, a)).json();
  const one = structuredClone(first.data),
    two = structuredClone(first.data);
  one.projects[0].notes = 'A';
  two.projects[0].notes = 'B';
  const results = await Promise.all([
    request('/workspace', 'PUT', { revision: 1, data: one }, a),
    request('/workspace', 'PUT', { revision: 1, data: two }, b),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const latest = await (await request('/workspace', 'GET', undefined, a)).json();
  assert.equal(latest.revision, 2);
  assert.ok(['A', 'B'].includes(latest.data.projects[0].notes));
  assert.equal(latest.data.tasks.length, 1);
});
test('imported fake actor/diff text is not trusted, and retention never rewrites current business data', async () => {
  const { a } = await setup(),
    d = data();
  const { recordChanges, emptyHistory } = await import('../src/lib/history');
  const changed = structuredClone(d);
  changed.projects[0].notes = '旧版本';
  const h = recordChanges(d, changed, emptyHistory()).history;
  for (const r of h.records) {
    r.actor = '伪造负责人';
    r.actorId = a.user.id;
    r.changes = [
      { module: 'private', label: 'forged', before: 'sensitive-forged-text', after: 'secret' },
    ];
  }
  const archive = { format: 'chunmo-history-backup', version: 1, data: changed, history: h };
  const preview = await (await request('/import/preview', 'POST', { archive }, a)).json();
  const committed = await request(
    '/import/commit',
    'POST',
    { id: preview.id, revision: 0, confirm: true },
    a,
  );
  assert.equal(committed.status, 200);
  const result = await committed.json();
  assert.ok(!JSON.stringify(result.history).includes('sensitive-forged-text'));
  assert.ok(
    result.history.records.some((r: any) => r.actor === '导入记录（身份未核验）' && !r.actorId),
  );
  const before = JSON.stringify(result.data);
  await maintain();
  const after = await (await request('/workspace', 'GET', undefined, a)).json();
  assert.equal(JSON.stringify(after.data), before);
});

test('server protects immutable purchase deadlines and approval history; owner-only explicit extension preserves original baseline', async () => {
  const { a, b } = await setup();
  const first = await request('/workspace', 'PUT', { revision: 0, data: data() }, a);
  assert.equal(first.status, 200);
  let state = await first.json();
  const id = state.data.purchases[0].id;
  const original = state.data.purchases[0].originalDue;
  const forged = structuredClone(state.data);
  forged.purchases[0].originalDue = '2099-01-01';
  assert.equal(
    (await request('/workspace', 'PUT', { revision: state.revision, data: forged }, b)).status,
    403,
  );
  const late = structuredClone(state.data);
  late.purchases[0].due = '2099-01-01';
  assert.equal(
    (await request('/workspace', 'PUT', { revision: state.revision, data: late }, a)).status,
    403,
  );
  const path = `/purchases/${id}/deadline`;
  assert.equal(
    (
      await request(
        path,
        'POST',
        { revision: state.revision, date: '2099-01-01', reason: '供应商确认新计划' },
        b,
      )
    ).status,
    403,
  );
  const extended = await request(
    path,
    'POST',
    { revision: state.revision, date: '2099-01-01', reason: '供应商确认新计划' },
    a,
  );
  assert.equal(extended.status, 200);
  state = await extended.json();
  const p = state.data.purchases[0];
  assert.equal(p.originalDue, original);
  assert.equal(p.approvedDue, '2099-01-01');
  assert.equal(p.deadlineHistory[0].reason, '供应商确认新计划');
  p.due = original;
  assert.equal(
    (await request('/workspace', 'PUT', { revision: state.revision, data: state.data }, b)).status,
    200,
  );
  const q = await pool.query(
    "SELECT action FROM audit_event WHERE workspace_id=$1 AND action='purchase.deadline.change'",
    [a.user.workspaceId],
  );
  assert.equal(q.rowCount, 1);
});

test('8–128 password boundaries, owner-only employee list/reset preserve account roles and complete business state', async () => {
  const { f, a, b } = await setup();
  const other = await fixtureAccounts();
  await request('/workspace', 'PUT', { revision: 0, data: data() }, a);
  const before = await (await request('/workspace', 'GET', undefined, a)).json();
  const accountBefore = (
    await pool.query('SELECT id,workspace_id,login,role,active FROM account WHERE id=$1', [
      f.employeeId,
    ])
  ).rows[0];
  assert.equal((await request('/accounts', 'GET', undefined, b)).status, 403);
  assert.equal(
    (await request('/accounts/' + f.employeeId, 'PATCH', { password: 'aaaaaaaa' }, b)).status,
    403,
  );
  const list = await (await request('/accounts', 'GET', undefined, a)).json();
  assert.deepEqual(list.accounts, [
    { id: f.employeeId, login: f.employee, displayName: f.employee, active: true },
  ]);
  assert.equal(
    (await request('/accounts/' + a.user.id, 'PATCH', { password: 'aaaaaaaa' }, a)).status,
    409,
  );
  for (const password of ['', '1234567', 'x'.repeat(129), ' '.repeat(8)]) {
    assert.equal(
      (await request('/accounts', 'POST', { login: 'invalid_' + randomUUID(), password }, a))
        .status,
      400,
    );
    assert.equal(
      (await request('/accounts/' + f.employeeId, 'PATCH', { password }, a)).status,
      400,
    );
  }
  assert.equal(
    (await request('/accounts/' + other.employeeId, 'PATCH', { password: 'aaaaaaaa' }, a)).status,
    404,
  );
  const name = 'eight_' + randomUUID();
  assert.equal(
    (await request('/accounts', 'POST', { login: name, password: 'aaaaaaaa' }, a)).status,
    201,
  );
  await login(name, 'aaaaaaaa');
  const second = await login(f.employee, f.password);
  const long = 'p'.repeat(128);
  assert.equal(
    (await request('/accounts/' + f.employeeId, 'PATCH', { password: long }, a)).status,
    200,
  );
  for (const client of [b, second])
    assert.equal((await request('/auth/session', 'GET', undefined, client)).status, 401);
  await login(f.employee, long);
  assert.deepEqual(
    (
      await pool.query('SELECT id,workspace_id,login,role,active FROM account WHERE id=$1', [
        f.employeeId,
      ])
    ).rows[0],
    accountBefore,
  );
  assert.deepEqual(await (await request('/workspace', 'GET', undefined, a)).json(), before);
  const row = (await pool.query('SELECT password_hash FROM account WHERE id=$1', [f.employeeId]))
    .rows[0];
  const hashParts = row.password_hash.split('$');
  assert.equal(hashParts[1], 'argon2id');
  assert.equal(hashParts[2], 'v=19');
  assert.deepEqual(
    Object.fromEntries(hashParts[3].split(',').map((part: string) => part.split('='))),
    { m: '65536', t: '3', p: '1' },
  );
  assert.ok(!JSON.stringify(list).includes(row.password_hash));
});

test('owner and employee self-change verify current password/confirmation/CSRF, revoke every old session and SSE, require fresh login', async () => {
  for (const owner of [true, false]) {
    const { f, a, b } = await setup();
    const client = owner ? a : b,
      name = owner ? f.login : f.employee;
    const second = await login(name, f.password);
    const newPassword = owner ? 'aaaaaaaa' : 'n'.repeat(128);
    const body = { currentPassword: f.password, newPassword, confirmPassword: newPassword };
    assert.equal((await request('/auth/password', 'POST', body)).status, 401);
    assert.equal(
      (await request('/auth/password', 'POST', body, client, { 'X-CSRF-Token': 'invalid' })).status,
      403,
    );
    assert.equal(
      (await request('/auth/password', 'POST', { ...body, confirmPassword: 'different' }, client))
        .status,
      400,
    );
    assert.equal(
      (await request('/auth/password', 'POST', { ...body, currentPassword: 'wrongpwd' }, client))
        .status,
      403,
    );
    assert.equal((await request('/auth/session', 'GET', undefined, second)).status, 200);
    const sse = await request('/events', 'GET', undefined, second);
    const changed = await request('/auth/password', 'POST', body, client);
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/);
    assert.match(await sse.text(), /event: session-expired/);
    for (const old of [client, second])
      assert.equal((await request('/auth/session', 'GET', undefined, old)).status, 401);
    assert.equal(
      (await request('/auth/login', 'POST', { login: name, password: f.password })).status,
      401,
    );
    const fresh = await login(name, newPassword);
    assert.equal(fresh.user.owner, owner);
    assert.equal((await request('/workspace', 'GET', undefined, fresh)).status, 200);
  }
});

test('password attempts use a shared per-account limiter and never change password on failures', async () => {
  const { f, b } = await setup();
  const another = await login(f.employee, f.password);
  for (let i = 0; i < 5; i++) {
    const r = await request(
      '/auth/password',
      'POST',
      { currentPassword: 'wrongpwd', newPassword: 'aaaaaaaa', confirmPassword: 'aaaaaaaa' },
      i % 2 ? another : b,
    );
    assert.equal(r.status, 403);
  }
  assert.equal(
    (
      await request(
        '/auth/password',
        'POST',
        { currentPassword: f.password, newPassword: 'aaaaaaaa', confirmPassword: 'aaaaaaaa' },
        b,
      )
    ).status,
    429,
  );
  assert.equal((await request('/auth/session', 'GET', undefined, another)).status, 200);
});

test('concurrent login and owner reset cannot leave sessions authenticated with the old password', async () => {
  const { f, a } = await setup();
  const results = await Promise.all([
    request('/auth/login', 'POST', { login: f.employee, password: f.password }),
    request('/accounts/' + f.employeeId, 'PATCH', { password: 'aaaaaaaa' }, a),
  ]);
  assert.equal(results[1].status, 200);
  assert.ok([200, 401].includes(results[0].status));
  if (results[0].status === 200) {
    const old = {
      cookie: results[0].headers.get('set-cookie')!.split(';')[0],
      csrf: '',
      user: null,
    };
    assert.equal((await request('/auth/session', 'GET', undefined, old)).status, 401);
  }
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM auth_session WHERE account_id=$1', [
        f.employeeId,
      ])
    ).rows[0].n,
    0,
  );
  await login(f.employee, 'aaaaaaaa');
});

test('owner password reset has a database-backed rate limit shared across target accounts', async () => {
  const { f, a } = await setup();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await request('/accounts/' + f.employeeId, 'PATCH', { password: 'aaaaaaaa' }, a)).status,
      200,
    );
  assert.equal(
    (await request('/accounts/' + f.employeeId, 'PATCH', { password: 'bbbbbbbb' }, a)).status,
    429,
  );
  await login(f.employee, 'aaaaaaaa');
});

test('V1.1 display names keep stable identities; private account notes isolate authors, owners and workspaces', async () => {
  const { f, a, b } = await setup();
  const foreign = await fixtureAccounts();
  const original = (
    await pool.query('SELECT id,login,password_hash,role,workspace_id FROM account WHERE id=$1', [
      a.user.id,
    ])
  ).rows[0];
  assert.equal((await request('/auth/profile', 'PATCH', { displayName: '马春旭' }, a)).status, 200);
  const current = await request('/auth/session', 'GET', undefined, a);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).user.displayName, '马春旭');
  assert.deepEqual(
    (
      await pool.query('SELECT id,login,password_hash,role,workspace_id FROM account WHERE id=$1', [
        a.user.id,
      ])
    ).rows[0],
    original,
  );
  assert.equal(
    (await request('/auth/profile', 'PATCH', { displayName: '木工小李' }, b)).status,
    200,
  );
  assert.equal(
    (await request('/accounts/' + a.user.id, 'PATCH', { displayName: '冒充负责人' }, b)).status,
    403,
  );
  assert.equal(
    (await request('/accounts/' + f.employeeId, 'PATCH', { displayName: '李师傅' }, a)).status,
    200,
  );
  assert.equal(
    (await request('/auth/session', 'GET', undefined, b)).status,
    200,
    'name-only edit keeps session',
  );
  assert.equal(
    (await request('/accounts/' + f.employeeId + '/note', 'PUT', { note: '仅负责人个人可见' }, a))
      .status,
    200,
  );
  assert.equal(
    (await request('/accounts/' + a.user.id + '/note', 'PUT', { note: '仅员工个人可见' }, b))
      .status,
    200,
  );
  const da = (await (await request('/directory', 'GET', undefined, a)).json()).accounts;
  const db = (await (await request('/directory', 'GET', undefined, b)).json()).accounts;
  assert.equal(da.find((x: any) => x.id === f.employeeId).note, '仅负责人个人可见');
  assert.equal(db.find((x: any) => x.id === a.user.id).note, '仅员工个人可见');
  assert.ok(!JSON.stringify(da).includes('仅员工个人可见'));
  assert.ok(!JSON.stringify(db).includes('仅负责人个人可见'));
  assert.equal(db.find((x: any) => x.id === f.employeeId).displayName, '李师傅');
  assert.equal(db.find((x: any) => x.id === a.user.id).login, f.login);
  assert.equal(
    (await request('/accounts/' + foreign.id + '/note', 'PUT', { note: '越界' }, b)).status,
    404,
  );
  assert.equal(
    (
      await request(
        '/accounts/' + a.user.id + '/note',
        'PUT',
        { note: '伪造', authorId: a.user.id },
        b,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request('/accounts/' + f.employeeId + '/note', 'PUT', { note: '' }, a)).status,
    200,
  );
  const stillPrivate = await (await request('/directory', 'GET', undefined, b)).json();
  assert.equal(stillPrivate.accounts.find((x: any) => x.id === a.user.id).note, '仅员工个人可见');
  const logs = await (await request('/audit', 'GET', undefined, a)).json();
  assert.ok(!JSON.stringify(logs).includes('仅员工个人可见'));
  assert.ok(!JSON.stringify(logs).includes('仅负责人个人可见'));
});

test('V1.1 server audit records object lifecycle, immutable actor snapshots and bounded device hints without private contents', async () => {
  const { f, a, b } = await setup();
  assert.equal((await request('/auth/profile', 'PATCH', { displayName: '马春旭' }, a)).status, 200);
  const d = data();
  const projectId = d.projects[0].id;
  d.projects[0].notes = 'private phone +8613800000000 password SECRET-DO-NOT-LOG';
  d.notes = [
    {
      id: randomUUID(),
      projectId,
      title: '现场确认',
      kind: '其他事项',
      date: d.projects[0].start,
      reminder: '',
      owner: 'private-name',
      content: 'personal-note-secret',
      done: false,
      pinned: false,
    },
  ];
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1 Version/18.5 Mobile/15E148 Safari/604.1 Cookie=do-not-record',
  };
  const first = await request('/workspace', 'PUT', { revision: 0, data: d }, a, headers);
  assert.equal(first.status, 200);
  const saved = await first.json();
  saved.data.projects[0].status = '暂停';
  saved.data.projects[0].notes = 'other-private-note';
  assert.equal(
    (await request('/workspace', 'PUT', { revision: 1, data: saved.data }, b)).status,
    200,
  );
  assert.equal(
    (await request('/auth/profile', 'PATCH', { displayName: '负责人新显示名' }, a)).status,
    200,
  );
  assert.equal(
    (await request('/workspace', 'PUT', { revision: 2, data: emptyData() }, a)).status,
    200,
  );
  const all = await (await request('/audit?limit=100', 'GET', undefined, b)).json();
  const create = all.events.find(
    (e: any) => e.entityType === 'project' && e.operation === 'create',
  );
  assert.match(create.entityId, /^obj_[a-f0-9]{24}$/);
  assert.equal(create.actorId, a.user.id);
  assert.equal(create.actorDisplayName, '马春旭');
  assert.equal(create.device.category, 'mobile');
  assert.equal(create.device.model, 'iPhone（具体型号不可识别）');
  assert.equal(create.device.browser, 'Safari');
  assert.ok(create.createdAt);
  const update = all.events.find(
    (e: any) => e.entityType === 'project' && e.operation === 'update',
  );
  assert.equal(update.actorId, f.employeeId);
  assert.equal(update.after.status, '暂停');
  assert.equal(update.before.status, '施工中');
  assert.ok(update.changedFields.includes('notes'));
  assert.ok(!('notes' in update.after));
  const deleted = all.events.find(
    (e: any) => e.entityType === 'project' && e.operation === 'delete',
  );
  assert.equal(deleted.actorDisplayName, '负责人新显示名');
  assert.equal(deleted.after, null);
  for (const entityType of ['project', 'trade', 'task', 'person', 'purchase', 'note'])
    assert.ok(all.events.some((e: any) => e.entityType === entityType && e.operation === 'create'));
  const text = JSON.stringify(all);
  for (const secret of [
    '+8613800000000',
    'SECRET-DO-NOT-LOG',
    'personal-note-secret',
    'do-not-record',
    'other-private-note',
    f.password,
    'password_hash',
    'token_hash',
    'Cookie=',
    projectId,
  ])
    assert.ok(!text.includes(secret), secret);
  const only = await (
    await request(
      '/audit?entityType=project&operation=create&actorId=' + a.user.id,
      'GET',
      undefined,
      a,
    )
  ).json();
  assert.equal(only.events.length, 1);
  assert.equal(only.events[0].id, create.id);
  const page = await (await request('/audit?limit=1', 'GET', undefined, a)).json();
  assert.equal(page.events.length, 1);
  assert.ok(page.nextCursor);
  const page2 = await (
    await request(
      '/audit?limit=1&cursor=' + encodeURIComponent(page.nextCursor),
      'GET',
      undefined,
      a,
    )
  ).json();
  assert.notEqual(page2.events[0].id, page.events[0].id);
  assert.equal((await request('/audit?from=garbage', 'GET', undefined, a)).status, 400);
  assert.equal((await request('/audit', 'GET')).status, 401);
  assert.equal((await request('/audit/' + create.id, 'DELETE', {}, b)).status, 404);
  await assert.rejects(
    pool.query('UPDATE audit_event SET action=$1 WHERE id=$2', ['forged', create.id]),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    pool.query('DELETE FROM audit_event WHERE id=$1', [create.id]),
    (e: any) => e.code === '42501',
  );
  const foreign = await fixtureAccounts();
  const outsider = await login(foreign.login, foreign.password);
  assert.equal(
    (await (await request('/audit?actorId=' + a.user.id, 'GET', undefined, outsider)).json()).events
      .length,
    0,
  );
});

test('owner and employee rename to canonical Chinese logins: IDs, permissions, data, private notes and prior audit ownership stay intact', async () => {
  for (const isOwner of [true, false]) {
    const { f, a, b } = await setup(),
      client = isOwner ? a : b,
      oldLogin = isOwner ? f.login : f.employee;
    await request('/workspace', 'PUT', { revision: 0, data: data() }, a);
    await request(
      '/accounts/' + (isOwner ? f.employeeId : a.user.id) + '/note',
      'PUT',
      { note: '个人私有备注保持' },
      client,
    );
    const before = await (await request('/workspace', 'GET', undefined, a)).json();
    const directoryBefore = await (await request('/directory', 'GET', undefined, client)).json();
    const identity = (await pool.query('SELECT * FROM account WHERE id=$1', [client.user.id]))
      .rows[0];
    const second = await login(oldLogin, f.password);
    assert.equal((await request('/auth/login-policy')).status, 401);
    const policy = await (await request('/auth/login-policy', 'GET', undefined, client)).json();
    assert.equal(policy.login, oldLogin);
    assert.equal(policy.canChange, true);
    assert.equal(policy.nextAllowedAt, null);
    const newLogin = (isOwner ? '负责人' : '员工') + '_' + randomUUID().slice(0, 8) + '_ＭＡ';
    const canonical = newLogin.normalize('NFKC').toLowerCase();
    assert.equal(
      (
        await request('/auth/login-name', 'POST', {
          newLogin,
          currentPassword: f.password,
          confirm: true,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin, currentPassword: f.password, confirm: true },
          client,
          { 'X-CSRF-Token': 'bad' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin, currentPassword: f.password, confirm: false },
          client,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin, currentPassword: 'wrongpwd', confirm: true },
          client,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          {
            newLogin,
            currentPassword: f.password,
            confirm: true,
            id: isOwner ? f.employeeId : a.user.id,
          },
          client,
        )
      ).status,
      400,
    );
    const sse = await request('/events', 'GET', undefined, second);
    const changed = await request(
      '/auth/login-name',
      'POST',
      { newLogin, currentPassword: f.password, confirm: true },
      client,
      {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17 Mobile/15E148 Safari/604.1',
      },
    );
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await changed.json()).login, canonical);
    assert.match(await sse.text(), /session-expired/);
    for (const stale of [client, second])
      assert.equal((await request('/auth/session', 'GET', undefined, stale)).status, 401);
    assert.equal(
      (await request('/auth/login', 'POST', { login: oldLogin, password: f.password })).status,
      401,
    );
    const fresh = await login(canonical.toUpperCase(), f.password);
    assert.equal(fresh.user.id, client.user.id);
    assert.equal(fresh.user.owner, isOwner);
    const updated = (await pool.query('SELECT * FROM account WHERE id=$1', [client.user.id]))
      .rows[0];
    assert.equal(updated.login, canonical);
    assert.equal(updated.login_key, canonical);
    assert.ok(updated.login_changed_at);
    for (const key of [
      'id',
      'workspace_id',
      'password_hash',
      'role',
      'active',
      'display_name',
      'created_at',
    ])
      assert.deepEqual(updated[key], identity[key]);
    assert.deepEqual(await (await request('/workspace', 'GET', undefined, fresh)).json(), before);
    const directory = await (await request('/directory', 'GET', undefined, fresh)).json();
    assert.deepEqual(
      directory.accounts
        .map((x: any) => ({ id: x.id, note: x.note }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
      directoryBefore.accounts
        .map((x: any) => ({ id: x.id, note: x.note }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
    );
    const event = (
      await pool.query(
        "SELECT * FROM audit_event WHERE actor_id=$1 AND action='account.login.change'",
        [client.user.id],
      )
    ).rows[0];
    assert.equal(event.before_value.login, oldLogin);
    assert.equal(event.after_value.login, canonical);
    assert.equal(event.after_value.loginChangedAt, updated.login_changed_at.toISOString());
    assert.equal(event.device.category, 'mobile');
    assert.equal(event.entity_id, client.user.id);
    assert.ok(!JSON.stringify(event).includes(f.password));
    const cooldown = await (await request('/auth/login-policy', 'GET', undefined, fresh)).json();
    assert.equal(cooldown.canChange, false);
    assert.equal(
      Date.parse(cooldown.nextAllowedAt) - Date.parse(cooldown.lastChangedAt),
      90 * 24 * 60 * 60 * 1000,
    );
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin: '再改_' + randomUUID(), currentPassword: f.password, confirm: true },
          fresh,
        )
      ).status,
      409,
    );
    await assert.rejects(
      pool.query('UPDATE account SET login_changed_at=NULL WHERE id=$1', [client.user.id]),
      (e: any) => e.code === '42501',
    );
    await assert.rejects(
      pool.query('UPDATE account SET login=$2 WHERE id=$1', [
        client.user.id,
        '再次_' + randomUUID(),
      ]),
      (e: any) => e.code === '23514',
    );
  }
});

test('canonical uniqueness is global; conflict rollback preserves sessions and cooldown, concurrent renames commit only once', async () => {
  const { f, a, b } = await setup();
  const other = await fixtureAccounts();
  const taken = '唯一_' + randomUUID().slice(0, 8) + '_ma';
  await pool.query('UPDATE account SET login=$2 WHERE id=$1', [other.employeeId, taken]);
  const body = {
    newLogin: taken.toUpperCase().replace('_MA', '_ＭＡ'),
    currentPassword: f.password,
    confirm: true,
  };
  assert.equal((await request('/auth/login-name', 'POST', body, b)).status, 409);
  assert.equal((await request('/auth/session', 'GET', undefined, b)).status, 200);
  assert.equal(
    (await (await request('/auth/login-policy', 'GET', undefined, b)).json()).canChange,
    true,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_event WHERE actor_id=$1 AND action='account.login.change'",
        [f.employeeId],
      )
    ).rows[0].n,
    0,
  );
  const result = await Promise.all([
    request(
      '/auth/login-name',
      'POST',
      { newLogin: '并发甲_' + randomUUID(), currentPassword: f.password, confirm: true },
      b,
    ),
    request(
      '/auth/login-name',
      'POST',
      { newLogin: '并发乙_' + randomUUID(), currentPassword: f.password, confirm: true },
      b,
    ),
  ]);
  assert.equal(result.filter((x) => x.status === 200).length, 1);
  assert.ok(result.every((x) => [200, 401, 409].includes(x.status)));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_event WHERE actor_id=$1 AND action='account.login.change'",
        [f.employeeId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM auth_session WHERE account_id=$1', [
        f.employeeId,
      ])
    ).rows[0].n,
    0,
  );
  // A separate account in the SAME studio can still change: cooldown belongs to identity.
  assert.equal(
    (
      await request(
        '/auth/login-name',
        'POST',
        { newLogin: '负责人_' + randomUUID(), currentPassword: f.password, confirm: true },
        a,
      )
    ).status,
    200,
  );
});

test('login-name current-password attempts share server rate limiting', async () => {
  const { f, b } = await setup();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin: '新账号_' + randomUUID(), currentPassword: 'wrongpwd', confirm: true },
          b,
        )
      ).status,
      403,
    );
  assert.equal(
    (
      await request(
        '/auth/login-name',
        'POST',
        { newLogin: '新账号_' + randomUUID(), currentPassword: f.password, confirm: true },
        b,
      )
    ).status,
    429,
  );
  assert.equal((await request('/auth/session', 'GET', undefined, b)).status, 200);
});

test('database 90-day boundary expires by real server time; no-op/timestamp tampering and audit failure roll back atomically', async () => {
  const { f, b } = await setup();
  const next = '日期甲_' + randomUUID();
  assert.equal(
    (
      await request(
        '/auth/login-name',
        'POST',
        { newLogin: next, currentPassword: f.password, confirm: true },
        b,
      )
    ).status,
    200,
  );
  const fresh = await login(next, f.password);
  const url = new URL(process.env.MIGRATION_DATABASE_URL!);
  assert.equal(config.APP_ENV, 'test');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/chunmo_test');
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    // Test-only clock seeding: LOCAL replication mode applies only to this admin
    // transaction on a freshly generated fixture row, never a production setting.
    const seed = async (interval: string) => {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL session_replication_role=replica');
        await admin.query(
          'UPDATE account SET login_changed_at=clock_timestamp()+$2::interval WHERE id=$1',
          [f.employeeId, interval],
        );
        await admin.query('COMMIT');
      } catch (e) {
        await admin.query('ROLLBACK');
        throw e;
      }
    };
    await seed('-2159 hours');
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin: '日期乙_' + randomUUID(), currentPassword: f.password, confirm: true },
          fresh,
        )
      ).status,
      409,
    );
    await assert.rejects(
      pool.query(
        "UPDATE account SET login_changed_at=clock_timestamp()-interval '91 days' WHERE id=$1",
        [f.employeeId],
      ),
      (e: any) => e.code === '42501',
    );
    await seed('-2160 hours');
    assert.equal(
      (await (await request('/auth/login-policy', 'GET', undefined, fresh)).json()).canChange,
      true,
    );
    // Force a constraint failure on an actual rename/audit transaction. Both
    // the DB-trigger session revocation and login timestamp must roll back.
    const before = (
      await pool.query('SELECT login,login_changed_at FROM account WHERE id=$1', [f.employeeId])
    ).rows[0];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE account SET login=$2 WHERE id=$1', [
        f.employeeId,
        '回滚_' + randomUUID(),
      ]);
      await assert.rejects(
        c.query(
          "INSERT INTO audit_event(id,workspace_id,actor_id,action) VALUES($1,$2,'missing-actor','test')",
          [randomUUID(), fresh.user.workspaceId],
        ),
        (e: any) => e.code === '23503',
      );
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    assert.deepEqual(
      (await pool.query('SELECT login,login_changed_at FROM account WHERE id=$1', [f.employeeId]))
        .rows[0],
      before,
    );
    assert.equal((await request('/auth/session', 'GET', undefined, fresh)).status, 200);
    assert.equal(
      (
        await request(
          '/auth/login-name',
          'POST',
          { newLogin: '日期乙_' + randomUUID(), currentPassword: f.password, confirm: true },
          fresh,
        )
      ).status,
      200,
    );
  } finally {
    await admin.end();
  }
});

test('V4 avatar: authenticated own writes, decoded PNG, size/CRC limits and workspace isolation', async () => {
  const { PNG } = await import('pngjs');
  const f = await fixtureAccounts(),
    other = await fixtureAccounts();
  const a = await login(f.login, f.password),
    b = await login(f.employee, f.password),
    c = await login(other.login, other.password);
  const image = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const payload = { image: 'data:image/png;base64,' + image.toString('base64') };
  assert.equal((await request('/auth/avatar', 'PUT', payload)).status, 401);
  assert.equal(
    (await request('/auth/avatar', 'PUT', { ...payload, accountId: b.user.id }, a)).status,
    400,
  );
  assert.equal((await request('/auth/avatar', 'PUT', payload, b)).status, 200);
  const read = await request('/accounts/' + b.user.id + '/avatar', 'GET', undefined, a);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(PNG.sync.read(Buffer.from(await read.arrayBuffer())).width, 2);
  assert.equal(
    (await request('/accounts/' + b.user.id + '/avatar', 'GET', undefined, c)).status,
    404,
  );
  for (const value of [
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,aGVsbG8=',
    'data:image/png;base64,' + Buffer.alloc(2097152).toString('base64'),
  ])
    assert.equal((await request('/auth/avatar', 'PUT', { image: value }, b)).status, 400);
  const corrupt = Buffer.from(image);
  corrupt[29] ^= 1;
  assert.equal(
    (
      await request(
        '/auth/avatar',
        'PUT',
        { image: 'data:image/png;base64,' + corrupt.toString('base64') },
        b,
      )
    ).status,
    400,
  );
  const huge = PNG.sync.write(new PNG({ width: 257, height: 1 }));
  assert.equal(
    (
      await request(
        '/auth/avatar',
        'PUT',
        { image: 'data:image/png;base64,' + huge.toString('base64') },
        b,
      )
    ).status,
    400,
  );
  assert.equal((await request('/auth/avatar', 'DELETE', {}, b)).status, 200);
  assert.equal(
    (await request('/accounts/' + b.user.id + '/avatar', 'GET', undefined, a)).status,
    404,
  );
});
test('V4 presence: only live authenticated SSE connections in the same workspace; logout removes visibility', async () => {
  const f = await fixtureAccounts(),
    o = await fixtureAccounts();
  const a = await login(f.login, f.password),
    b = await login(f.employee, f.password),
    c = await login(o.login, o.password);
  assert.equal((await request('/presence')).status, 401);
  assert.deepEqual((await (await request('/presence', 'GET', undefined, a)).json()).accounts, []);
  const controller = new AbortController();
  const stream = await fetch(base + '/api/events', {
    headers: { Cookie: b.cookie, Origin: config.APP_ORIGIN },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.equal(
    (await (await request('/presence', 'GET', undefined, a)).json()).accounts[0].id,
    b.user.id,
  );
  assert.deepEqual((await (await request('/presence', 'GET', undefined, c)).json()).accounts, []);
  await request('/auth/logout', 'POST', {}, b);
  assert.deepEqual((await (await request('/presence', 'GET', undefined, a)).json()).accounts, []);
  controller.abort();
});
