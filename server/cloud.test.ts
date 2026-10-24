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
