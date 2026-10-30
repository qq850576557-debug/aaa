import pg from 'pg';
import sharp from 'sharp';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from './app';
import { pool, privatePool, transaction } from './db';
import { saveWorkspaceSubmission } from './workspace-save';
import { fixtureAccounts } from './test-fixtures';
import { config } from './config';
import { emptyData, newProject, defaultTrades, today, plus, type Data } from '../src/lib/model';
import { migrate } from './migrate';
import { maintain } from './maintenance';
let server: Server, base: string;
let testClientIp = '127.0.0.1';
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
      'X-Forwarded-For': testClientIp,
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
test('record board: authenticated workspace scope, trustworthy history, deletion preservation and no inventory/workspace coupling', async () => {
  testClientIp = '203.0.113.171';
  const { a, b, f } = await setup(),
    d = data();
  assert.equal((await request('/workspace', 'PUT', { revision: 0, data: d }, a)).status, 200);
  const originalWorkspace = await (await request('/workspace', 'GET', undefined, a)).json();
  const value = {
    projectId: d.projects[0].id,
    title: '复核门套',
    nodeDate: '2026-10-29',
    status: '待执行',
    notes: '仅存于正文的私密备注',
    followUp: '明天现场确认',
  };
  assert.equal((await request('/records')).status, 401);
  assert.equal(
    (
      await request('/records', 'POST', { requestId: randomUUID(), value }, b, {
        'X-CSRF-Token': 'wrong',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/records', 'POST', { requestId: randomUUID(), value, actorId: f.id }, b))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        '/records',
        'POST',
        { requestId: randomUUID(), value: { ...value, projectId: 'outside' } },
        b,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/records',
        'POST',
        { requestId: randomUUID(), value: { ...value, nodeDate: '2026-02-30' } },
        b,
      )
    ).status,
    400,
  );
  await request('/auth/profile', 'PATCH', { displayName: '当时员工姓名' }, b);
  const body = { requestId: randomUUID(), value };
  const created = await request('/records', 'POST', body, b);
  assert.equal(created.status, 200);
  let r = await created.json();
  assert.equal(r.createdBy, f.employeeId);
  assert.equal(r.createdName, '当时员工姓名');
  assert.ok(Math.abs(Date.now() - Date.parse(r.createdAt)) < 10000);
  const retry = await (await request('/records', 'POST', body, b)).json();
  assert.deepEqual(retry, r);
  assert.equal(
    (await request('/records', 'POST', { ...body, value: { ...value, title: '另一内容' } }, b))
      .status,
    409,
  );
  assert.equal((await request('/records', 'POST', body, a)).status, 409);
  const other = await fixtureAccounts(),
    stranger = await login(other.login, other.password);
  assert.equal(
    (await (await request('/records', 'GET', undefined, stranger)).json()).records.length,
    0,
  );
  assert.equal((await request(`/records/${r.id}/history`, 'GET', undefined, stranger)).status, 404);
  assert.equal(
    (
      await request(
        `/records/${r.id}`,
        'PUT',
        { version: r.version, requestId: randomUUID(), value },
        stranger,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/records/${r.id}`,
        'DELETE',
        { version: r.version, requestId: randomUUID() },
        stranger,
      )
    ).status,
    404,
  );
  await request('/auth/profile', 'PATCH', { displayName: '新的员工姓名' }, b);
  const update = await request(
    `/records/${r.id}`,
    'PUT',
    {
      requestId: randomUUID(),
      version: r.version,
      value: { ...value, status: '持续跟进', nodeDate: '2026-10-30' },
    },
    b,
  );
  assert.equal(update.status, 200);
  r = await update.json();
  assert.equal(r.updatedName, '新的员工姓名');
  assert.equal(r.createdName, '当时员工姓名');
  const h = await (await request(`/records/${r.id}/history`, 'GET', undefined, b)).json();
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].before.status, '待执行');
  assert.equal(h.events[0].after.status, '持续跟进');
  assert.equal(h.events[1].actorName, '当时员工姓名');
  assert.ok(!JSON.stringify(h.events).includes(value.notes));
  const audited = await (await request('/audit?entityType=record', 'GET', undefined, a)).json();
  assert.equal(audited.events.length, 2);
  assert.ok(!JSON.stringify(audited).includes(value.notes));
  const relogin = await login(f.employee, f.password);
  assert.equal(
    (await (await request('/records', 'GET', undefined, relogin)).json()).records[0].version,
    2,
  );
  const deletion = { requestId: randomUUID(), version: r.version };
  assert.equal((await request(`/records/${r.id}`, 'DELETE', deletion, b)).status, 200);
  assert.equal((await request(`/records/${r.id}`, 'DELETE', deletion, b)).status, 200);
  assert.equal((await (await request('/records', 'GET', undefined, b)).json()).records.length, 0);
  const deleted = await (await request(`/records/${r.id}/history`, 'GET', undefined, a)).json();
  assert.equal(deleted.record.deleted, true);
  assert.equal(deleted.events.length, 3);
  assert.equal(deleted.events[0].operation, 'delete');
  const saved = await (await request('/workspace', 'GET', undefined, a)).json();
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.data, originalWorkspace.data);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM material_event WHERE workspace_id=$1', [
        f.workspaceId,
      ])
    ).rows[0].n,
    0,
  );
});
test('record board: concurrent edits, duplicate submissions, deleted projects and database append-only protection', async () => {
  testClientIp = '203.0.113.172';
  const { a, b, f } = await setup(),
    d = data();
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  const value = {
    projectId: d.projects[0].id,
    title: '现场收口核验',
    nodeDate: '',
    status: '进行中',
    notes: '',
    followUp: '',
  };
  const r = await (await request('/records', 'POST', { requestId: randomUUID(), value }, a)).json();
  const updates = await Promise.all(
    [a, b].map((client, i) =>
      request(
        `/records/${r.id}`,
        'PUT',
        { requestId: randomUUID(), version: 1, value: { ...value, followUp: '现场反馈' + i } },
        client,
      ),
    ),
  );
  assert.deepEqual(updates.map((x) => x.status).sort(), [200, 409]);
  const winner = await updates.find((x) => x.status === 200)!.json();
  assert.equal(
    (await (await request(`/records/${r.id}/history`, 'GET', undefined, a)).json()).events.length,
    2,
  );
  const bad = await request(
    `/records/${r.id}`,
    'PUT',
    { requestId: randomUUID(), version: winner.version, value: { ...value, projectId: 'another' } },
    a,
  );
  assert.equal(bad.status, 400);
  assert.equal(
    (await (await request('/records', 'GET', undefined, a)).json()).records[0].version,
    2,
  );
  for (const table of ['record_history', 'record_submission']) {
    await assert.rejects(
      pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [f.workspaceId]),
      (e: any) => e.code === '42501',
    );
    assert.equal(
      (await pool.query("SELECT has_table_privilege(current_user,$1,'UPDATE') ok", [table])).rows[0]
        .ok,
      false,
    );
  }
  await assert.rejects(
    pool.query('DELETE FROM work_record WHERE workspace_id=$1', [f.workspaceId]),
    (e: any) => e.code === '42501',
  );
  // Ordinary project graph rebuild/removal cannot cascade-delete records or history.
  assert.equal(
    (await request('/workspace', 'PUT', { revision: 1, data: emptyData() }, a)).status,
    200,
  );
  const retained = await (await request('/records', 'GET', undefined, a)).json();
  assert.equal(retained.records[0].projectName, d.projects[0].name);
  assert.equal(
    (
      await request(
        `/records/${r.id}`,
        'PUT',
        {
          requestId: randomUUID(),
          version: winner.version,
          value: { ...value, notes: '项目移除后仍可收尾' },
        },
        a,
      )
    ).status,
    200,
  );
});
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

test('owner rename to canonical Chinese login: IDs, permissions, data, private notes and prior audit ownership stay intact', async () => {
  for (const isOwner of [true]) {
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
  const { f, a } = await setup();
  const other = await fixtureAccounts();
  const taken = '唯一_' + randomUUID().slice(0, 8) + '_ma';
  await pool.query('UPDATE account SET login=$2 WHERE id=$1', [other.employeeId, taken]);
  const body = {
    newLogin: taken.toUpperCase().replace('_MA', '_ＭＡ'),
    currentPassword: f.password,
    confirm: true,
  };
  assert.equal((await request('/auth/login-name', 'POST', body, a)).status, 409);
  assert.equal((await request('/auth/session', 'GET', undefined, a)).status, 200);
  assert.equal(
    (await (await request('/auth/login-policy', 'GET', undefined, a)).json()).canChange,
    true,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_event WHERE actor_id=$1 AND action='account.login.change'",
        [f.id],
      )
    ).rows[0].n,
    0,
  );
  const result = await Promise.all([
    request(
      '/auth/login-name',
      'POST',
      { newLogin: '并发甲_' + randomUUID(), currentPassword: f.password, confirm: true },
      a,
    ),
    request(
      '/auth/login-name',
      'POST',
      { newLogin: '并发乙_' + randomUUID(), currentPassword: f.password, confirm: true },
      a,
    ),
  ]);
  assert.equal(result.filter((x) => x.status === 200).length, 1);
  assert.ok(result.every((x) => [200, 401, 409].includes(x.status)));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_event WHERE actor_id=$1 AND action='account.login.change'",
        [f.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM auth_session WHERE account_id=$1', [f.id]))
      .rows[0].n,
    0,
  );
  // A different studio's owner remains independently eligible.
  const otherOwner = await login(other.login, other.password);
  assert.equal(
    (
      await request(
        '/auth/login-name',
        'POST',
        { newLogin: '另一负责人_' + randomUUID(), currentPassword: other.password, confirm: true },
        otherOwner,
      )
    ).status,
    200,
  );
});

test('login-name current-password attempts share server rate limiting', async () => {
  const { f, a: b } = await setup();
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
  const { f, a: b } = await setup();
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
          [f.id, interval],
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
        [f.id],
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
      await pool.query('SELECT login,login_changed_at FROM account WHERE id=$1', [f.id])
    ).rows[0];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE account SET login=$2 WHERE id=$1', [f.id, '回滚_' + randomUUID()]);
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
      (await pool.query('SELECT login,login_changed_at FROM account WHERE id=$1', [f.id])).rows[0],
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
  const image = PNG.sync.write(new PNG({ width: 720, height: 720 }));
  const payload = { image: 'data:image/png;base64,' + image.toString('base64') };
  assert.equal((await request('/auth/avatar', 'PUT', payload)).status, 401);
  assert.equal(
    (await request('/auth/avatar', 'PUT', { ...payload, accountId: b.user.id }, a)).status,
    400,
  );
  assert.equal((await request('/auth/avatar', 'PUT', payload, b)).status, 200);
  const read = await request('/accounts/' + b.user.id + '/avatar', 'GET', undefined, a);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/jpeg');
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal((await sharp(Buffer.from(await read.arrayBuffer())).metadata()).width, 720);
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

test('account grants: staff self-profile/avatar/password only; rename/admin/import/private endpoints reject direct role bypass', async () => {
  const { f, a, b } = await setup();
  const before = (
    await pool.query(
      'SELECT id,login,password_hash,role,active,login_changed_at FROM account WHERE id=$1',
      [f.employeeId],
    )
  ).rows[0];
  const forbidden: [string, string, unknown][] = [
    ['/auth/login-policy', 'GET', undefined],
    [
      '/auth/login-name',
      'POST',
      { newLogin: '员工改名_' + randomUUID(), currentPassword: f.password, confirm: true },
    ],
    ['/accounts', 'GET', undefined],
    ['/accounts', 'POST', { login: 'forged_' + randomUUID(), password: f.password }],
    ['/accounts/' + f.id, 'PATCH', { active: false }],
    ['/accounts/' + f.employeeId, 'PATCH', { active: false }],
    ['/accounts/' + f.id, 'PATCH', { password: 'abcdefgh' }],
    ['/accounts/' + f.employeeId, 'PATCH', { role: 'owner', permissions: ['*'] }],
    ['/import/preview', 'POST', { archive: emptyData() }],
    ['/import/commit', 'POST', { id: 'guess', revision: 0, confirm: true }],
    ['/people/guess/private', 'GET', undefined],
    ['/people/guess/private', 'PUT', { phone: '13800000000', birthDate: '1990-01-01' }],
  ];
  for (const [path, method, body] of forbidden) {
    const r = await request(path, method, body, b, { 'X-Role': 'owner', 'X-Owner': 'true' });
    assert.equal(r.status, 403, path);
  }
  for (const key of ['login', 'role', 'permissions', 'active'])
    assert.equal(
      (
        await request(
          '/auth/profile',
          'PATCH',
          { displayName: '员工姓名', [key]: key === 'active' ? false : 'owner' },
          b,
        )
      ).status,
      400,
    );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT id,login,password_hash,role,active,login_changed_at FROM account WHERE id=$1',
        [f.employeeId],
      )
    ).rows[0],
    before,
  );
  assert.equal((await request('/auth/session', 'GET', undefined, b)).status, 200);
  assert.equal(
    (await request('/auth/profile', 'PATCH', { displayName: '员工可改展示名' }, b)).status,
    200,
  );
  const directory = await request('/directory', 'GET', undefined, b);
  assert.equal(directory.status, 200);
  const text = await directory.text();
  for (const key of ['password_hash', 'birthDate', 'phone', 'token_hash'])
    assert.equal(text.includes(key), false);
  assert.equal((await request('/audit', 'GET', undefined, b)).status, 200);
  assert.equal((await request('/directory')).status, 401);
  assert.equal((await request('/audit')).status, 401);
});

test('display-name audit snapshots stay immutable; employee can read full studio audit without cross-studio leakage', async () => {
  const { a, b } = await setup(),
    d = data();
  await request('/auth/profile', 'PATCH', { displayName: '旧展示名称' }, b);
  assert.equal((await request('/workspace', 'PUT', { revision: 0, data: d }, b)).status, 200);
  const old = (
    await (await request('/audit?entityType=project', 'GET', undefined, b)).json()
  ).events.find((x: any) => x.actorId === b.user.id);
  assert.equal(old.actorDisplayName, '旧展示名称');
  await request('/auth/profile', 'PATCH', { displayName: '新展示名称' }, b);
  d.projects[0].name = '新业务操作';
  await request('/workspace', 'PUT', { revision: 1, data: d }, b);
  const changed = (await (await request('/audit?entityType=project', 'GET', undefined, b)).json())
    .events;
  assert.equal(changed.find((x: any) => x.id === old.id).actorDisplayName, '旧展示名称');
  assert.equal(changed[0].actorDisplayName, '新展示名称');
  await request('/auth/profile', 'PATCH', { displayName: '负责人名称' }, a);
  const all = (await (await request('/audit', 'GET', undefined, b)).json()).events;
  assert.ok(all.some((x: any) => x.actorId === a.user.id));
  const other = await fixtureAccounts(),
    outside = await login(other.employee, other.password);
  assert.equal(
    (await (await request('/audit?actorId=' + b.user.id, 'GET', undefined, outside)).json()).events
      .length,
    0,
  );
});

test('daily assessments: default deny, separate recorder grant and no leak via public history/export', async () => {
  const { a, b } = await setup(),
    d = data();
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  const key = {
    date: '2026-10-27',
    personId: d.people![0].id,
    projectId: d.projects[0].id,
    tradeId: d.trades[0].id,
    version: 0,
    changes: { photo: 'yes' },
  };
  for (const [path, method, body] of [
    ['/assessments', 'GET', undefined],
    ['/assessments/export', 'GET', undefined],
    ['/assessments/unknown/history', 'GET', undefined],
    ['/assessments/batch', 'POST', { requestId: randomUUID(), confirmed: true, edits: [key] }],
    ['/assessments/recorders/' + b.user.id, 'PUT', { enabled: true }],
  ] as const)
    assert.equal((await request(path, method, body, b, { 'X-Role': 'owner' })).status, 403, path);
  assert.equal((await request('/assessments')).status, 401);
  assert.deepEqual(await (await request('/assessments/access', 'GET', undefined, b)).json(), {
    allowed: false,
    owner: false,
  });
  const body = { requestId: randomUUID(), confirmed: true, edits: [key] };
  assert.equal((await request('/assessments/batch', 'POST', body, a)).status, 200);
  const exported = await (await request('/export', 'GET', undefined, b)).text();
  assert.equal(exported.includes('createdBy'), false);
  assert.equal(exported.includes('assessment_history'), false);
  const auditEvents = (await (await request('/audit', 'GET', undefined, b)).json()).events.filter(
    (e: any) => e.action === 'assessment.save',
  );
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].before, null);
  assert.equal(auditEvents[0].after, null);
});
test('daily assessments: supervisor records independent tri-state values, version history, idempotency and revocation', async () => {
  const { f, a, b } = await setup(),
    d = data();
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  assert.equal(
    (await request('/assessments/recorders/' + b.user.id, 'PUT', { enabled: true }, a)).status,
    200,
  );
  const edit = {
    date: '2026-10-27',
    personId: d.people![0].id,
    projectId: d.projects[0].id,
    tradeId: d.trades[0].id,
    version: 0,
    changes: { attendance: 'yes' },
  };
  const body = { requestId: randomUUID(), confirmed: true, edits: [edit] };
  const made = await request('/assessments/batch', 'POST', body, b);
  assert.equal(made.status, 200);
  const r = (await made.json()).records[0];
  assert.equal(r.createdBy, f.employeeId);
  assert.equal(r.photo, 'pending');
  assert.equal(r.cleaning, 'pending');
  assert.equal(r.version, 1);
  const replay = await (await request('/assessments/batch', 'POST', body, b)).json();
  assert.deepEqual(replay.records[0], r);
  assert.equal(
    (
      await request(
        '/assessments/batch',
        'POST',
        { ...body, edits: [{ ...edit, changes: { photo: 'no' } }] },
        b,
      )
    ).status,
    409,
  );
  await request('/auth/profile', 'PATCH', { displayName: '监理新名称' }, b);
  const changed = await request(
    '/assessments/batch',
    'POST',
    {
      requestId: randomUUID(),
      confirmed: true,
      edits: [{ ...edit, version: 1, changes: { photo: 'no', cleaning: 'yes' } }],
    },
    b,
  );
  assert.equal(changed.status, 200);
  const after = (await changed.json()).records[0];
  assert.equal(after.attendance, 'yes');
  assert.equal(after.createdBy, f.employeeId);
  assert.equal(after.createdName, r.createdName);
  assert.equal(after.updatedName, '监理新名称');
  const events = (
    await (await request('/assessments/' + r.id + '/history', 'GET', undefined, b)).json()
  ).events;
  assert.equal(events.length, 2);
  assert.equal(events[0].before.photo, 'pending');
  assert.equal(events[0].after.photo, 'no');
  await assert.rejects(
    pool.query('DELETE FROM assessment_history WHERE workspace_id=$1', [f.workspaceId]),
  );
  assert.equal(
    (
      await request(
        '/assessments/batch',
        'POST',
        { requestId: randomUUID(), confirmed: true, edits: [edit] },
        b,
      )
    ).status,
    409,
  );
  const result = await request(
    '/assessments/export?from=2026-10-27&to=2026-10-27',
    'GET',
    undefined,
    b,
  );
  assert.equal(result.status, 200);
  assert.match(await result.text(), /未拍照/);
  const outsider = await fixtureAccounts();
  assert.equal(
    (await request('/assessments/recorders/' + outsider.employeeId, 'PUT', { enabled: true }, a))
      .status,
    404,
  );
  const other = await login(outsider.login, outsider.password);
  assert.deepEqual(
    (await (await request('/assessments/' + r.id + '/history', 'GET', undefined, other)).json())
      .events,
    [],
  );
  assert.equal(
    (
      await request(
        '/assessments/batch',
        'POST',
        {
          requestId: randomUUID(),
          confirmed: true,
          edits: [{ ...edit, personId: outsider.employeeId }],
        },
        b,
      )
    ).status,
    400,
  );
  await request('/assessments/recorders/' + b.user.id, 'PUT', { enabled: false }, a);
  assert.equal((await request('/assessments', 'GET', undefined, b)).status, 403);
  assert.equal((await request('/assessments/export', 'GET', undefined, b)).status, 403);
});
test('daily assessments: concurrent writes cannot overwrite, batches roll back atomically, dates/projects remain isolated', async () => {
  const { a } = await setup(),
    d = data(),
    p2 = { ...d.projects[0], id: randomUUID(), name: '另一工地' };
  d.projects.push(p2);
  d.trades.push({ ...d.trades[0], id: randomUUID(), projectId: p2.id });
  await request('/workspace', 'PUT', { revision: 0, data: d }, a);
  const edit = {
    date: '2026-10-26',
    personId: d.people![0].id,
    projectId: d.projects[0].id,
    tradeId: d.trades[0].id,
    version: 0,
    changes: { photo: 'yes' },
  };
  const submit = (edits: unknown[]) =>
    request('/assessments/batch', 'POST', { requestId: randomUUID(), confirmed: true, edits }, a);
  const races = await Promise.all([
    submit([edit]),
    submit([{ ...edit, changes: { photo: 'no' } }]),
  ]);
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await submit([
        { ...edit, date: '2026-10-27' },
        { ...edit, projectId: p2.id },
      ])
    ).status,
    400,
  );
  const afterRollback = await (
    await request('/assessments?from=2026-10-27&to=2026-10-27', 'GET', undefined, a)
  ).json();
  assert.equal(afterRollback.records.length, 0);
  assert.equal(
    (
      await submit([
        { ...edit, date: '2026-10-27' },
        { ...edit, date: '2026-10-27', projectId: p2.id, tradeId: d.trades.at(-1)!.id },
      ])
    ).status,
    200,
  );
  const rows = (
    await (await request('/assessments?from=2026-10-26&to=2026-10-27', 'GET', undefined, a)).json()
  ).records;
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r: any) => r.id)).size, 3);
  assert.equal((await submit([edit, edit])).status, 400);
  assert.equal((await submit([{ ...edit, date: '2026-02-30' }])).status, 400);
  // Replacing business projections / restoring 15-day history does not cascade away assessments.
  assert.equal(
    (await request('/workspace', 'PUT', { revision: 1, data: emptyData() }, a)).status,
    200,
  );
  assert.equal(
    (
      await (
        await request('/assessments?from=2026-10-26&to=2026-10-27', 'GET', undefined, a)
      ).json()
    ).records.length,
    3,
  );
});

test('member cards: self/owner employment-date access is server enforced and private values never enter public directory/export/audit', async () => {
  const { f, a, b } = await setup();
  const body = { displayName: '陈工', englishName: 'Chris CHEN', joinedOn: '2019-07-08' };
  assert.equal((await request('/member-cards/me', 'PUT', body, b)).status, 200);
  const cards = (await (await request('/member-cards', 'GET', undefined, b)).json()).cards;
  const me = cards.find((r: any) => r.id === f.employeeId);
  assert.equal(me.joinedOn, body.joinedOn);
  assert.equal(me.englishName, body.englishName);
  assert.equal(me.displayName, body.displayName);
  assert.equal(me.login, f.employee);
  assert.equal(me.owner, false);
  assert.equal((await request('/auth/session', 'GET', undefined, b)).status, 200);
  assert.equal(
    (await request('/member-cards/me', 'PUT', { ...body, departmentId: 'forged' }, b)).status,
    400,
  );
  assert.equal(
    (await request('/member-cards/' + f.employeeId, 'PUT', { ...body, departmentId: null }, b))
      .status,
    403,
  );
  assert.equal(
    (await request('/member-cards/' + f.id, 'PUT', { ...body, departmentId: null }, b)).status,
    403,
  );
  assert.equal(
    (await request('/member-cards/me', 'PUT', { ...body, joinedOn: '2026-02-30' }, b)).status,
    400,
  );
  const otherAccount = await request(
    '/accounts',
    'POST',
    { login: 'card_' + randomUUID(), password: f.password, displayName: '另一位员工' },
    a,
  );
  const id = (await otherAccount.json()).id;
  const other = await login(
    (await pool.query('SELECT login FROM account WHERE id=$1', [id])).rows[0].login,
    f.password,
  );
  const publicCards = (await (await request('/member-cards', 'GET', undefined, other)).json())
    .cards;
  assert.equal(
    Object.hasOwn(
      publicCards.find((r: any) => r.id === f.employeeId),
      'joinedOn',
    ),
    false,
  );
  assert.equal(JSON.stringify(publicCards).includes(body.joinedOn), false);
  assert.equal(
    (await (await request('/member-cards', 'GET', undefined, a)).json()).cards.find(
      (r: any) => r.id === f.employeeId,
    ).joinedOn,
    body.joinedOn,
  );
  for (const path of ['/directory', '/export', '/audit'])
    assert.equal(
      (await (await request(path, 'GET', undefined, other)).text()).includes(body.joinedOn),
      false,
      path,
    );
  const outsider = await fixtureAccounts(),
    outside = await login(outsider.login, outsider.password);
  assert.equal(
    (
      await request(
        '/member-cards/' + f.employeeId,
        'PUT',
        { ...body, departmentId: null },
        outside,
      )
    ).status,
    404,
  );
  assert.equal(
    (await (await request('/member-cards', 'GET', undefined, outside)).text()).includes(
      body.joinedOn,
    ),
    false,
  );
  assert.equal((await request('/member-cards')).status, 401);
  const row = (await pool.query('SELECT id,login,role FROM account WHERE id=$1', [f.employeeId]))
    .rows[0];
  assert.deepEqual(row, { id: f.employeeId, login: f.employee, role: 'employee' });
});
test('departments: owner maintains bilingual dictionary, disabled references survive, in-use deletion and staff administration are blocked', async () => {
  const { f, a, b } = await setup();
  const dept = { name: '设计部门', englishName: 'Design Studio', active: true };
  assert.equal((await request('/departments', 'POST', dept, b)).status, 403);
  const made = await request('/departments', 'POST', dept, a);
  assert.equal(made.status, 201);
  const id = (await made.json()).id;
  assert.equal((await request('/departments', 'POST', dept, a)).status, 409);
  const card = {
    displayName: '李设计',
    englishName: 'Lily LI',
    joinedOn: '2020-09-01',
    departmentId: id,
  };
  assert.equal((await request('/member-cards/' + f.employeeId, 'PUT', card, a)).status, 200);
  const publicCard = (
    await (await request('/member-cards', 'GET', undefined, b)).json()
  ).cards.find((r: any) => r.id === f.employeeId);
  assert.equal(publicCard.departmentName, dept.name);
  assert.equal(publicCard.departmentEnglishName, dept.englishName);
  assert.equal((await request('/departments/' + id, 'DELETE', {}, a)).status, 409);
  assert.equal(
    (await request('/departments/' + id, 'PUT', { ...dept, active: false }, a)).status,
    200,
  );
  assert.equal(
    (await request('/member-cards/' + f.employeeId, 'PUT', { ...card, englishName: 'Lily' }, a))
      .status,
    200,
  );
  assert.equal(
    (await request('/member-cards/' + f.id, 'PUT', { ...card, displayName: '负责人' }, a)).status,
    409,
  );
  assert.equal((await request('/departments/' + id, 'PUT', dept, b)).status, 403);
  assert.equal((await request('/departments/' + id, 'DELETE', {}, b)).status, 403);
  assert.equal(
    (await request('/member-cards/' + f.employeeId, 'PUT', { ...card, departmentId: null }, a))
      .status,
    200,
  );
  assert.equal((await request('/departments/' + id, 'DELETE', {}, a)).status, 200);
  const foreign = await fixtureAccounts(),
    foreignOwner = await login(foreign.login, foreign.password);
  assert.equal((await request('/departments/' + id, 'PUT', dept, foreignOwner)).status, 404);
});

async function materialFixture() {
  const base = await setup(),
    d = data();
  d.projects.push({ ...d.projects[0], id: randomUUID(), name: '材料接收工地', status: '已完工' });
  const saved = await request('/workspace', 'PUT', { revision: 0, data: d }, base.a);
  assert.equal(saved.status, 200);
  const m = await request(
    '/materials/items',
    'PUT',
    {
      id: '',
      version: 0,
      value: {
        name: '防滑地砖',
        category: '瓷砖',
        unit: 'm²',
        specification: '600×600',
        performance: '防滑A',
        active: true,
        conversions: [{ unit: '箱', factor: '1.44' }],
      },
    },
    base.a,
  );
  assert.equal(m.status, 200, await m.clone().text());
  const material = await m.json();
  const r = await request(
    '/materials/contexts',
    'PUT',
    {
      id: '',
      version: 0,
      value: {
        projectId: d.projects[0].id,
        materialId: material.id,
        phase: '铺贴',
        zone: '客厅',
        tradeId: d.trades[0].id,
        taskId: d.tasks[0].id,
        teamName: '铺贴一组',
        staffIds: [d.people![0].id],
        basisKind: 'area',
        basis: '10',
        coats: 1,
        process: '薄贴',
        paving: '直铺',
        budgetQty: '10',
        budgetPrice: '10',
        progress: 50,
        finalized: false,
      },
    },
    base.a,
  );
  assert.equal(r.status, 200, await r.clone().text());
  const context = await r.json();
  const event = (
    kind: string,
    quantity: string,
    patch: Record<string, unknown> = {},
    client = base.a,
  ) =>
    kind === 'transfer'
      ? completedTransfer(base.a.user.id, d, material.id, quantity, patch, client)
      : request(
          '/materials/events',
          'POST',
          {
            requestId: randomUUID(),
            kind,
            quantity,
            inputUnit: 'm²',
            unitPrice: '10',
            date: today(),
            projectId: d.projects[0].id,
            materialId: material.id,
            contextId: context.id,
            targetProjectId: '',
            purchaseId: '',
            referenceId: '',
            reason: '现场核对原始单据',
            ...patch,
          },
          client,
        );
  const state = async (client = base.a) => {
    const r = await request('/materials', 'GET', undefined, client);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { ...base, d, material, context, event, state };
}
test('materials: independent authorization, workspace isolation, CSRF, immutable history and exact-idempotent receipt', async () => {
  const x = await materialFixture(),
    { a, b, d, material, context } = x;
  assert.equal((await request('/materials')).status, 401);
  assert.equal((await request('/materials/access', 'GET', undefined, b)).status, 200);
  for (const path of [
    '/materials',
    '/materials/export',
    '/materials/alerts',
    '/materials/history/' + context.id,
  ])
    assert.equal((await request(path, 'GET', undefined, b)).status, 403, path);
  assert.equal((await x.event('receipt', '10', {}, b)).status, 403);
  assert.equal(
    (await request('/materials/operators/' + b.user.id, 'PUT', { enabled: true }, b)).status,
    403,
  );
  assert.equal(
    (await request('/materials/operators/' + b.user.id, 'PUT', { enabled: true }, a)).status,
    200,
  );
  const requestId = randomUUID();
  const races = await Promise.all([
    x.event('receipt', '10', { requestId, purchaseId: d.purchases[0].id }, b),
    x.event('receipt', '10', { requestId, purchaseId: d.purchases[0].id }, b),
  ]);
  assert.deepEqual(
    races.map((r) => r.status),
    [200, 200],
  );
  assert.equal((await races[0].json()).id, (await races[1].json()).id);
  assert.equal(
    (await x.event('receipt', '11', { requestId, purchaseId: d.purchases[0].id }, b)).status,
    409,
  );
  const s = await x.state();
  assert.equal(s.events.length, 1);
  assert.equal(s.analysis.stocks[0].siteQty, '10.000');
  assert.equal(s.events[0].actorId, b.user.id);
  assert.equal(s.events[0].purchaseId, d.purchases[0].id);
  assert.equal(
    (
      await request(
        '/materials/items',
        'PUT',
        {
          id: '',
          version: 0,
          value: {
            name: '攻击',
            category: '瓷砖',
            unit: 'm²',
            specification: '600',
            performance: 'A',
            active: true,
            conversions: [],
          },
        },
        b,
      )
    ).status,
    403,
  );
  assert.equal((await x.event('reverse', '0', { referenceId: s.events[0].id }, b)).status, 403);
  const foreign = await setup();
  assert.equal(
    (await request('/materials/history/' + s.events[0].id, 'GET', undefined, foreign.a)).status,
    200,
  );
  assert.equal(
    (
      await (
        await request('/materials/history/' + s.events[0].id, 'GET', undefined, foreign.a)
      ).json()
    ).events.length,
    0,
  );
  assert.equal((await x.event('receipt', '1', { actorId: foreign.a.user.id })).status, 400);
  assert.equal(
    (await request('/materials/operators/' + foreign.a.user.id, 'PUT', { enabled: true }, a))
      .status,
    404,
  );
  assert.equal((await x.event('receipt', '1', { purchaseId: 'foreign-purchase' })).status, 400);
  const h = (
    await (await request('/materials/history/' + s.events[0].id, 'GET', undefined, a)).json()
  ).events;
  assert.equal(h.length, 1);
  assert.equal(h[0].actorId, b.user.id);
  for (const table of [
    'material_event',
    'material_history',
    'material_item',
    'material_context',
    'material_project_meta',
    'material_alert',
    'member_card',
  ])
    await assert.rejects(
      pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [a.user.workspaceId]),
      (e: any) => e.code === '42501',
    );
  assert.equal(
    (await request('/materials/refresh-alerts', 'POST', {}, a, { 'X-CSRF-Token': 'invalid' }))
      .status,
    403,
  );
  assert.equal(
    (await request('/materials/operators/' + b.user.id, 'PUT', { enabled: false }, a)).status,
    200,
  );
  assert.equal((await request('/materials/export', 'GET', undefined, b)).status, 403);
});
test('materials: opening/receipt/issue/use/returns/transfer/count/loss/cleanup reconcile quantities and cost, protected CSV remains traceable', async () => {
  const x = await materialFixture();
  for (const [kind, q, patch] of [
    ['order', '500', {}],
    ['opening', '100', {}],
    ['receipt', '20', {}],
    ['issue', '60', {}],
    ['use', '40', {}],
    ['loss_crew', '5', {}],
    ['return', '15', {}],
    ['supplier_return', '5', {}],
    ['transfer', '10', { targetProjectId: x.d.projects[1].id }],
  ] as [string, string, Record<string, unknown>][]) {
    const r = await x.event(kind, q, patch);
    assert.equal(r.status, 200, await r.clone().text());
  }
  let s = await x.state(),
    a = s.analysis.stocks.find((r: any) => r.projectId === x.d.projects[0].id),
    b = s.analysis.stocks.find((r: any) => r.projectId === x.d.projects[1].id);
  assert.equal(a.siteQty, '60.000');
  assert.equal(a.used, '40.000');
  assert.equal(a.loss, '5.000');
  assert.equal(b.siteQty, '10.000');
  assert.equal(a.value, '600.00');
  assert.equal(b.value, '100.00');
  assert.equal(s.analysis.rows[0].samples, 0);
  assert.equal(s.analysis.rows[0].probability, null);
  const count = await x.event('count_site', '55', { contextId: '' });
  assert.equal(count.status, 200);
  const id = (await count.json()).id;
  assert.equal((await x.event('loss_site', '3', { referenceId: id })).status, 200);
  assert.equal((await x.event('adjust_out', '2', { referenceId: id, contextId: '' })).status, 200);
  assert.equal((await x.event('adjust_out', '1', { referenceId: id, contextId: '' })).status, 409);
  assert.equal((await x.event('issue', '56')).status, 409);
  assert.equal((await x.event('receipt', '1', { date: '2026-09-30' })).status, 409);
  assert.equal((await x.event('receipt', '1', { date: '2099-01-01' })).status, 400);
  assert.equal((await x.event('receipt', '1', { inputUnit: 'kg' })).status, 400);
  assert.equal(
    (await x.event('close', '0', { projectId: x.d.projects[1].id, contextId: '' })).status,
    409,
  );
  assert.equal(
    (
      await x.event('transfer', '10', {
        projectId: x.d.projects[1].id,
        contextId: '',
        targetProjectId: x.d.projects[0].id,
      })
    ).status,
    200,
  );
  assert.equal(
    (await x.event('close', '0', { projectId: x.d.projects[1].id, contextId: '' })).status,
    200,
  );
  assert.equal(
    (await x.event('receipt', '1', { projectId: x.d.projects[1].id, contextId: '' })).status,
    409,
  );
  s = await x.state();
  a = s.analysis.stocks.find((r: any) => r.projectId === x.d.projects[0].id);
  assert.equal(a.siteQty, '65.000');
  assert.equal(a.loss, '8.000');
  assert.equal(a.counts[0].difference, '0.000');
  assert.equal(a.counts[0].physical, '65.000');
  const csv = await request('/materials/export', 'GET', undefined, x.a);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  const text = await csv.text();
  assert.ok(text.includes(id));
  assert.ok(text.includes(x.a.user.id));
  assert.ok(text.includes('1.44') === false);
  assert.ok(text.includes(x.material.id));
  const filtered = await request(
    '/materials/export?category=' + encodeURIComponent('水电'),
    'GET',
    undefined,
    x.a,
  );
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.text()).includes(x.material.id), false);
  const filteredType = await request(
    '/materials/export?projectType=' + encodeURIComponent('不存在类型'),
    'GET',
    undefined,
    x.a,
  );
  assert.equal(filteredType.status, 200);
  assert.equal((await filteredType.text()).includes(x.material.id), false);
});
test('materials: concurrent transfers and CAS prevent overselling/overwrites, immutable correction and alert workflow retain history across project restore', async () => {
  const x = await materialFixture();
  assert.equal((await x.event('opening', '100')).status, 200);
  const race = await Promise.all([
    x.event('transfer', '70', { targetProjectId: x.d.projects[1].id }),
    x.event('transfer', '70', { targetProjectId: x.d.projects[1].id }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const successful = await race.find((r) => r.status === 200)!.json();
  assert.equal((await x.event('reverse', '0', { referenceId: successful.id })).status, 409); // Received transfers are not reversible ledger edits.
  assert.equal((await x.event('reverse', '0', { referenceId: successful.id })).status, 409);
  assert.equal((await x.event('issue', '20')).status, 200);
  assert.equal((await x.event('use', '20')).status, 200);
  let s = await x.state();
  const alert = s.alerts.find((r: any) => r.detail.key === 'usage:' + x.context.id);
  assert.ok(alert);
  assert.equal(alert.detail.samples, 0);
  assert.equal(alert.detail.probability, null);
  assert.equal(alert.status, '待核查');
  assert.equal(
    (
      await request(
        '/materials/alerts/' + alert.id,
        'PUT',
        { version: alert.version, status: '已关闭', assigneeId: '', reason: '跳过核查' },
        x.a,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        '/materials/alerts/' + alert.id,
        'PUT',
        { version: alert.version, status: '核查中', assigneeId: x.a.user.id, reason: '现场复核' },
        x.a,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        '/materials/alerts/' + alert.id,
        'PUT',
        { version: alert.version, status: '已确认异常', assigneeId: '', reason: '旧版本' },
        x.a,
      )
    ).status,
    409,
  );
  for (const status of ['已确认异常', '已处理', '已关闭']) {
    s = await x.state();
    const r = s.alerts.find((a: any) => a.id === alert.id);
    assert.equal(
      (
        await request(
          '/materials/alerts/' + alert.id,
          'PUT',
          { version: r.version, status, assigneeId: x.a.user.id, reason: '有据核查并复核' },
          x.a,
        )
      ).status,
      200,
    );
  }
  const hist = await (
    await request('/materials/history/' + alert.id, 'GET', undefined, x.a)
  ).json();
  assert.equal(hist.events.length, 5);
  const value = { ...x.context };
  delete value.id;
  delete value.version;
  delete value.projectName;
  const cas = await Promise.all([
    request(
      '/materials/contexts',
      'PUT',
      { id: x.context.id, version: 1, value: { ...value, budgetQty: '25' } },
      x.a,
    ),
    request(
      '/materials/contexts',
      'PUT',
      { id: x.context.id, version: 1, value: { ...value, budgetQty: '30' } },
      x.a,
    ),
  ]);
  assert.deepEqual(cas.map((r) => r.status).sort(), [200, 409]);
  const before = await x.state();
  const edited = structuredClone(x.d);
  edited.projects[0].name = '临时名称';
  const w = await (await request('/workspace', 'PUT', { revision: 1, data: edited }, x.a)).json();
  const history = w.history.records.findLast((r: any) => r.scope === x.d.projects[0].id);
  assert.equal(
    (await request('/history/restore', 'POST', { revision: 2, id: history.id }, x.a)).status,
    200,
  );
  const restored = await x.state();
  assert.deepEqual(restored.events, before.events);
  assert.deepEqual(restored.contexts, before.contexts);
  assert.deepEqual(restored.alerts, before.alerts);
  assert.equal((await request('/materials/refresh-alerts', 'POST', {}, x.a)).status, 200);
  assert.deepEqual((await x.state()).events, before.events);
});
async function completedTransfer(
  handlerId: string,
  d: Data,
  materialId: string,
  quantity: string,
  patch: Record<string, unknown>,
  client: Client,
) {
  let r = await request(
    '/materials/transfers',
    'POST',
    {
      requestId: randomUUID(),
      projectId: patch.projectId ?? d.projects[0].id,
      targetProjectId: patch.targetProjectId,
      materialId,
      quantity,
      handlerId,
      transportCost: '0',
      reason: '测试完整交接',
    },
    client,
  );
  if (r.status !== 200) return r;
  let t = await r.clone().json();
  for (const action of ['approve', 'dispatch', 'receive']) {
    r = await request(
      '/materials/transfers/' + t.id,
      'POST',
      {
        requestId: randomUUID(),
        version: t.version,
        action,
        quantity,
        reason: '测试交接 ' + action,
      },
      client,
    );
    if (r.status !== 200) return r;
    t = await r.clone().json();
  }
  return r;
}
test('V1.1 purchases: trusted provenance, completion/reopen history, deletion retention, role checks and re-login persistence', async () => {
  testClientIp = '192.0.2.10'; // Isolate synthetic clients without disabling rate limits.

  const { a, b, f } = await setup();
  let s = await (await request('/workspace', 'PUT', { revision: 0, data: data() }, a)).json();
  const id = s.data.purchases[0].id;
  const change = async (client: Client, status: string) => {
    const d = structuredClone(s.data);
    d.purchases[0].status = status;
    const r = await request('/workspace', 'PUT', { revision: s.revision, data: d }, client);
    if (r.status === 200) s = await r.clone().json();
    return r;
  };
  assert.equal((await change(b, '已完成')).status, 200);
  let meta = (await (await request('/purchase-records', 'GET', undefined, b)).json()).records.find(
    (x: any) => x.id === id,
  );
  assert.ok(meta.createdAt);
  assert.ok(meta.completedAt);
  assert.equal(meta.createdName, a.user.displayName);
  assert.equal(meta.completedName, b.user.displayName);
  assert.equal((await change(b, '待采购')).status, 403);
  assert.equal((await change(a, '待采购')).status, 200);
  assert.equal((await change(b, '已完成')).status, 200);
  const bad = structuredClone(s.data);
  bad.purchases[0].completedBy = a.user.id;
  assert.equal(
    (await request('/workspace', 'PUT', { revision: s.revision, data: bad }, b)).status,
    400,
  );
  const events = (
    await (await request('/purchase-records/' + id + '/history', 'GET', undefined, b)).json()
  ).events;
  assert.deepEqual(
    events.map((e: any) => e.operation),
    ['创建', '完成', '恢复待采购', '完成'],
  );
  assert.equal(events[1].actorId, b.user.id);
  assert.ok(events[1].at);
  await request('/auth/logout', 'POST', {}, b);
  const fresh = await login(f.employee, f.password);
  assert.equal(
    (await (await request('/workspace', 'GET', undefined, fresh)).json()).data.purchases[0].status,
    '已完成',
  );
  const d = structuredClone(s.data);
  d.purchases = [];
  s = await (await request('/workspace', 'PUT', { revision: s.revision, data: d }, fresh)).json();
  meta = (await (await request('/purchase-records', 'GET', undefined, a)).json()).records.find(
    (x: any) => x.id === id,
  );
  assert.equal(meta.deleted, true);
  assert.ok(meta.completedAt);
  assert.equal(
    (await request('/purchase-records/' + id + '/history', 'GET', undefined, a)).status,
    200,
  );
  const forged = structuredClone(s.data);
  forged.purchases = [{ ...events[0].after, status: '待采购' }];
  assert.equal(
    (await request('/workspace', 'PUT', { revision: s.revision, data: forged }, fresh)).status,
    403,
  );
  const outsider = await setup();
  assert.deepEqual(
    (
      await (
        await request('/purchase-records/' + id + '/history', 'GET', undefined, outsider.a)
      ).json()
    ).events,
    [],
  );
  const completeTime = meta.completedAt;
  const restorePoint = s.history.records.findLast((r: any) => r.scope === s.data.projects[0].id);
  assert.equal(
    (await request('/history/restore', 'POST', { revision: s.revision, id: restorePoint.id }, a))
      .status,
    200,
  );
  const restoredMeta = (
    await (await request('/purchase-records', 'GET', undefined, a)).json()
  ).records.find((r: any) => r.id === id);
  assert.equal(restoredMeta.deleted, false);
  assert.equal(restoredMeta.completedAt, completeTime);
});
test('V1.1 transfer lifecycle: request reserves no destination stock, partial reception/returns/loss, roles, duplicate operations and history', async () => {
  testClientIp = '192.0.2.11'; // Isolate synthetic clients without disabling rate limits.

  const x = await materialFixture();
  assert.equal((await x.event('opening', '100')).status, 200);
  const create = {
    requestId: randomUUID(),
    projectId: x.d.projects[0].id,
    targetProjectId: x.d.projects[1].id,
    materialId: x.material.id,
    quantity: '60',
    handlerId: x.a.user.id,
    transportCost: '12.50',
    reason: '核对质量和后续需求',
  };
  assert.equal((await request('/materials/transfers', 'POST', create, x.b)).status, 403);
  let t = await (await request('/materials/transfers', 'POST', create, x.a)).json();
  assert.equal(t.status, '申请');
  assert.equal((await x.state()).analysis.stocks[0].siteQty, '100.000');
  assert.equal((await request('/materials/transfers', 'POST', create, x.a)).status, 200);
  const act = async (action: string, quantity = '0', client = x.a, extra = {}) => {
    const r = await request(
      '/materials/transfers/' + t.id,
      'POST',
      {
        requestId: randomUUID(),
        version: t.version,
        action,
        quantity,
        reason: '核验 ' + action,
        ...extra,
      },
      client,
    );
    if (r.status === 200) t = await r.clone().json();
    return r;
  };
  assert.equal((await act('dispatch')).status, 409);
  assert.equal((await act('approve')).status, 200);
  assert.equal((await act('dispatch')).status, 200);
  let state = await x.state();
  assert.equal(
    state.analysis.stocks.find((s: any) => s.projectId === x.d.projects[0].id).siteQty,
    '40.000',
  );
  assert.equal(
    state.analysis.stocks.find((s: any) => s.projectId === x.d.projects[1].id).siteQty,
    '0.000',
  );
  assert.equal((await act('cancel')).status, 409);
  assert.equal((await act('receive', '25')).status, 200);
  assert.equal(t.status, '部分接收');
  assert.equal((await act('receive', '36')).status, 409);
  const retry = {
    requestId: randomUUID(),
    version: t.version,
    action: 'return',
    quantity: '20',
    reason: '退回未使用余量',
  };
  assert.equal((await request('/materials/transfers/' + t.id, 'POST', retry, x.a)).status, 200);
  assert.equal((await request('/materials/transfers/' + t.id, 'POST', retry, x.a)).status, 200);
  t = await (await request('/materials/transfers/' + t.id, 'POST', retry, x.a)).json();
  assert.equal(t.returned, '20.000');
  assert.equal(
    (await request('/materials/transfers/' + t.id, 'POST', { ...retry, quantity: '21' }, x.a))
      .status,
    409,
  );
  await request('/materials/operators/' + x.b.user.id, 'PUT', { enabled: true }, x.a);
  assert.equal((await act('loss', '15', x.b)).status, 403);
  assert.equal((await act('loss', '15')).status, 200);
  assert.equal(t.status, '差异关闭');
  state = await x.state();
  assert.equal(
    state.analysis.stocks.find((s: any) => s.projectId === x.d.projects[0].id).siteQty,
    '60.000',
  );
  assert.equal(
    state.analysis.stocks.find((s: any) => s.projectId === x.d.projects[1].id).siteQty,
    '25.000',
  );
  const history = (
    await (await request('/materials/history/' + t.id, 'GET', undefined, x.a)).json()
  ).events;
  assert.equal(history.length, 6);
  assert.equal(history[0].actorId, x.a.user.id);
  const c = await request(
    '/materials/transfers',
    'POST',
    { ...create, requestId: randomUUID(), quantity: '2' },
    x.a,
  );
  t = await c.json();
  assert.equal((await act('cancel')).status, 200);
  assert.equal(t.status, '已取消');
  assert.equal((await act('approve')).status, 409);
  assert.equal(
    (
      await x.event('transfer_dispatch', '1', {
        referenceId: t.id,
        targetProjectId: x.d.projects[1].id,
      })
    ).status,
    409,
  );
  // Deleting a reminder and restoring project history cannot erase material/transfer facts.
  assert.equal((await x.event('order', '1', { purchaseId: x.d.purchases[0].id })).status, 200);
  const transferBefore = await (
      await request('/materials/transfers', 'GET', undefined, x.a)
    ).json(),
    materialBefore = await x.state();
  const w = await (await request('/workspace', 'GET', undefined, x.a)).json(),
    change = structuredClone(w.data);
  change.purchases = [];
  const changed = await (
    await request('/workspace', 'PUT', { revision: w.revision, data: change }, x.a)
  ).json();
  assert.deepEqual((await x.state()).events, materialBefore.events);
  const point = changed.history.records.findLast((r: any) => r.scope === x.d.projects[0].id);
  assert.equal(
    (await request('/history/restore', 'POST', { revision: changed.revision, id: point.id }, x.a))
      .status,
    200,
  );
  assert.deepEqual(
    await (await request('/materials/transfers', 'GET', undefined, x.a)).json(),
    transferBefore,
  );
  assert.deepEqual((await x.state()).events, materialBefore.events);
});
test('V1.1 separate card and system images: strict upload validation, privacy and reauthentication preserve independent bytes', async () => {
  testClientIp = '192.0.2.12'; // Isolate synthetic clients without disabling rate limits.

  const { PNG } = await import('pngjs');
  const { a, b, f } = await setup();
  const image = (n: number) => {
    const p = new PNG({ width: 720, height: 720 });
    p.data.fill(n);
    return { image: 'data:image/png;base64,' + PNG.sync.write(p).toString('base64') };
  };
  assert.equal((await request('/auth/avatar', 'PUT', image(120), b)).status, 200);
  const original = Buffer.from(
    await (
      await request('/accounts/' + f.employeeId + '/avatar', 'GET', undefined, a)
    ).arrayBuffer(),
  );
  assert.equal((await request('/auth/card-avatar', 'PUT', image(210), b)).status, 200);
  assert.notDeepEqual(
    Buffer.from(
      await (
        await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, a)
      ).arrayBuffer(),
    ),
    original,
  );
  assert.deepEqual(
    Buffer.from(
      await (
        await request('/accounts/' + f.employeeId + '/avatar', 'GET', undefined, a)
      ).arrayBuffer(),
    ),
    original,
  );
  assert.equal(
    (await request('/auth/card-avatar', 'PUT', { ...image(20), accountId: f.id }, b)).status,
    400,
  );
  const other = await setup();
  assert.equal(
    (await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, other.a)).status,
    404,
  );
  await request('/auth/logout', 'POST', {}, b);
  const fresh = await login(f.employee, f.password),
    profile = await (await request('/auth/session', 'GET', undefined, fresh)).json();
  assert.ok(profile.user.cardAvatarVersion);
  assert.ok(profile.user.avatarVersion);
  await request('/auth/avatar', 'DELETE', {}, fresh);
  assert.equal(
    (await request('/accounts/' + f.employeeId + '/avatar', 'GET', undefined, a)).status,
    404,
  );
  assert.equal(
    (await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, a)).status,
    200,
  );
  assert.equal(
    (await request('/auth/card-avatar', 'PUT', { image: 'data:image/png;base64,aGVsbG8=' }, fresh))
      .status,
    400,
  );
});

test('card photo: source resolution, original high pixels, retained legacy images and workspace scope', async () => {
  testClientIp = '192.0.2.28';
  const { PNG } = await import('pngjs');
  const { a, b, f } = await setup();
  const encode = (width: number, height: number) => {
    const p = new PNG({ width, height });
    p.data.fill(180);
    return { image: 'data:image/png;base64,' + PNG.sync.write(p).toString('base64') };
  };
  assert.equal((await request('/auth/card-avatar', 'PUT', encode(1440, 1080), b)).status, 200);
  const saved = await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, a);
  const image = await sharp(Buffer.from(await saved.arrayBuffer())).metadata();
  assert.equal(image.width, 1440);
  assert.equal(image.height, 1080);
  for (const path of ['/auth/card-avatar', '/auth/avatar']) {
    const low = await request(path, 'PUT', encode(1080, 719), b);
    assert.equal(low.status, 400);
    assert.match((await low.json()).error, /720px/);
    assert.equal((await request(path, 'PUT', encode(720, 720), b)).status, 200);
  }
  const other = await setup();
  assert.equal(
    (await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, other.a)).status,
    404,
  );
  const transparent = await sharp({
    create: { width: 720, height: 720, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  assert.equal(
    (
      await request(
        '/auth/card-avatar',
        'PUT',
        { image: 'data:image/png;base64,' + transparent.toString('base64') },
        b,
      )
    ).status,
    200,
  );
  const painted = await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, a);
  const pixel = await sharp(Buffer.from(await painted.arrayBuffer()))
    .raw()
    .toBuffer();
  for (const [i, value] of [237, 243, 238].entries())
    assert.ok(
      Math.abs(pixel[i] - value) <= 2,
      'transparent source matches the crop preview background',
    );
  // Historical lower-resolution bytes remain readable; new upload rules do not delete or rewrite them.
  const legacy = Buffer.from(encode(256, 256).image.split(',')[1], 'base64');
  await pool.query('UPDATE card_avatar SET png=$2,version=$3 WHERE account_id=$1', [
    f.employeeId,
    legacy,
    'retained-legacy',
  ]);
  const old = await request('/accounts/' + f.employeeId + '/card-avatar', 'GET', undefined, a);
  assert.equal(old.headers.get('content-type'), 'image/png');
  assert.equal(PNG.sync.read(Buffer.from(await old.arrayBuffer())).width, 256);
});

// The legacy CAS test below intentionally remains strict. Signed bases only enable safe intent merging.
async function workspaceBase(client: Client) {
  const r = await request('/workspace', 'GET', undefined, client);
  assert.equal(r.status, 200);
  return await r.json();
}
function submission(s: any, edit: (d: Data) => void, requestId = randomUUID()) {
  const next = structuredClone(s.data) as Data;
  edit(next);
  return { revision: s.revision, base: s.data, baseProof: s.baseProof, data: next, requestId };
}
async function seededWorkspace() {
  const f = await setup(),
    d = data();
  d.projects.push({ ...newProject(), name: '独立工地乙' });
  d.notes = [
    {
      id: randomUUID(),
      projectId: d.projects[0].id,
      title: '现场备忘',
      kind: '项目备忘',
      date: '',
      reminder: '',
      owner: '',
      content: '原始备注',
      done: false,
      pinned: false,
    },
  ];
  const r = await request('/workspace', 'PUT', { revision: 0, data: d }, f.a);
  assert.equal(r.status, 200);
  return f;
}
test('workspace concurrency: legacy global CAS reproduces invalid conflict; signed independent projects, records and fields all merge', async () => {
  testClientIp = '203.0.113.211';
  const { a, b } = await seededWorkspace();
  let sa = await workspaceBase(a),
    sb = await workspaceBase(b);
  const one = structuredClone(sa.data),
    two = structuredClone(sb.data);
  one.projects[0].notes = '甲编辑';
  two.projects[1].notes = '乙编辑';
  const legacy = await Promise.all([
    request('/workspace', 'PUT', { revision: sa.revision, data: one }, a),
    request('/workspace', 'PUT', { revision: sb.revision, data: two }, b),
  ]);
  assert.deepEqual(
    legacy.map((r) => r.status).sort(),
    [200, 409],
    'existing full-workspace CAS rejects independent changes',
  );
  [sa, sb] = await Promise.all([workspaceBase(a), workspaceBase(b)]);
  const independent = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(sa, (d) => {
        d.projects[0].notes = '独立甲';
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(sb, (d) => {
        d.projects[1].notes = '独立乙';
      }),
      b,
    ),
  ]);
  assert.deepEqual(
    independent.map((r) => r.status),
    [200, 200],
  );
  [sa, sb] = await Promise.all([workspaceBase(a), workspaceBase(b)]);
  const originalEnd = sa.data.tasks[0].end;
  const records = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(sa, (d) => {
        d.tasks[0].end = plus(d.tasks[0].end, 1);
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(sb, (d) => {
        d.notes[0].content = '监理备忘';
      }),
      b,
    ),
  ]);
  assert.deepEqual(
    records.map((r) => r.status),
    [200, 200],
  );
  [sa, sb] = await Promise.all([workspaceBase(a), workspaceBase(b)]);
  const fields = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(sa, (d) => {
        d.purchases[0].status = '已完成';
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(sb, (d) => {
        d.purchases[0].notes = '不同字段';
      }),
      b,
    ),
  ]);
  assert.deepEqual(
    fields.map((r) => r.status),
    [200, 200],
  );
  const final = await workspaceBase(a);
  assert.equal(final.data.projects[0].notes, '独立甲');
  assert.equal(final.data.projects[1].notes, '独立乙');
  assert.equal(final.data.tasks[0].end, plus(originalEnd, 1));
  assert.equal(final.data.notes[0].content, '监理备忘');
  assert.equal(final.data.purchases[0].status, '已完成');
  assert.equal(final.data.purchases[0].notes, '不同字段');
  const tracked = (await (await request('/purchase-records', 'GET', undefined, a)).json())
    .records[0];
  assert.equal(tracked.completedName, a.user.displayName);
  assert.ok(final.history.records.some((r: any) => r.actorId === b.user.id));
});
test('workspace concurrency: same field conflicts expose exact latest values; deletion/edit and invalid relation merges roll back', async () => {
  testClientIp = '203.0.113.212';
  const { a, b } = await seededWorkspace();
  let [sa, sb] = await Promise.all([workspaceBase(a), workspaceBase(b)]);
  const race = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(sa, (d) => {
        d.purchases[0].notes = '负责人先改';
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(sb, (d) => {
        d.purchases[0].notes = '员工先改';
      }),
      b,
    ),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const success = await race.find((r) => r.status === 200)!.json(),
    conflict = await race.find((r) => r.status === 409)!.json();
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].field, 'notes');
  assert.equal(conflict.conflicts[0].remote, success.data.purchases[0].notes);
  assert.equal(conflict.current.revision, success.revision);
  assert.equal((await workspaceBase(a)).revision, success.revision);
  [sa, sb] = await Promise.all([workspaceBase(a), workspaceBase(b)]);
  const deletion = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(sa, (d) => {
        d.notes = [];
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(sb, (d) => {
        d.notes[0].title = '编辑未删除';
      }),
      b,
    ),
  ]);
  assert.deepEqual(deletion.map((r) => r.status).sort(), [200, 409]);
  // Both input snapshots are valid. Merged date bounds are not: transaction must not write them.
  sa = await workspaceBase(a);
  sb = await workspaceBase(b);
  const task = sa.data.tasks[0],
    earlier = task.start,
    later = task.end;
  const changedA = submission(sa, (d) => {
    d.tasks[0].start = later;
  });
  const changedB = submission(sb, (d) => {
    d.tasks[0].end = earlier;
  });
  const dates = await Promise.all([
    request('/workspace', 'PUT', changedA, a),
    request('/workspace', 'PUT', changedB, b),
  ]);
  assert.deepEqual(dates.map((r) => r.status).sort(), [200, 409]);
  const after = await workspaceBase(a);
  assert.equal(after.revision, sa.revision + 1);
  assert.ok(after.data.tasks[0].start <= after.data.tasks[0].end);
  const row = await pool.query('SELECT payload FROM task WHERE workspace_id=$1 AND id=$2', [
    a.user.workspaceId,
    task.id,
  ]);
  assert.deepEqual(row.rows[0].payload, after.data.tasks[0]);
});
test('workspace concurrency: simultaneous duplicate receipts execute once and proof/permissions remain enforced', async () => {
  testClientIp = '203.0.113.213';
  const { a, b } = await seededWorkspace();
  const s = await workspaceBase(a),
    body = submission(s, (d) => {
      d.purchases[0].status = '已完成';
    });
  const r = await Promise.all(
    Array.from({ length: 4 }, () => request('/workspace', 'PUT', body, a)),
  );
  assert.deepEqual(
    r.map((x) => x.status),
    [200, 200, 200, 200],
  );
  const final = await workspaceBase(a);
  assert.equal(final.revision, s.revision + 1);
  const receipts = await pool.query(
    "SELECT count(*)::int n FROM audit_event WHERE workspace_id=$1 AND action='workspace.submit' AND entity_id=$2",
    [a.user.workspaceId, body.requestId],
  );
  assert.equal(receipts.rows[0].n, 1);
  const trace = await pool.query(
    "SELECT count(*)::int n FROM purchase_action WHERE workspace_id=$1 AND purchase_id=$2 AND operation='完成'",
    [a.user.workspaceId, body.data.purchases[0].id],
  );
  assert.equal(trace.rows[0].n, 1, 'retry cannot execute completion twice');
  assert.equal(
    (
      await request(
        '/workspace',
        'PUT',
        { ...body, data: { ...body.data, recentColors: ['#123456'] } },
        a,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request('/workspace', 'PUT', body, b)).status,
    403,
    'proof cannot be reused by a different account',
  );
  const forged = submission(final, (d) => {
    d.projects[0].name = '伪造';
  });
  forged.base.projects[0].name = '篡改基线';
  assert.equal((await request('/workspace', 'PUT', forged, a)).status, 403);
  const employee = await workspaceBase(b);
  assert.equal(
    (
      await request(
        '/workspace',
        'PUT',
        submission(employee, (d) => {
          d.projects = [];
          d.tasks = [];
          d.trades = [];
          d.notes = [];
          d.purchases = [];
        }),
        b,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/workspace',
        'PUT',
        submission(employee, (d) => {
          d.purchases[0].originalDue = '2027-01-01';
        }),
        b,
      )
    ).status,
    403,
  );
  const stranger = await fixtureAccounts(),
    c = await login(stranger.login, stranger.password);
  assert.equal(
    (await request('/workspace', 'PUT', { ...body, requestId: randomUUID() }, c)).status,
    403,
  );
  assert.equal((await workspaceBase(a)).revision, final.revision);
  const tracking = (await (await request('/purchase-records', 'GET', undefined, a)).json())
    .records[0];
  assert.equal(tracking.completedName, a.user.displayName);
});
test('workspace concurrency: four authenticated people repeatedly save distinct projects from the same stale revision without loss or duplicates', async () => {
  testClientIp = '203.0.113.214';
  const { a, b, f } = await seededWorkspace(),
    clients = [a, b];
  for (let n = 0; n < 2; n++) {
    const name = 'four_' + randomUUID().replaceAll('-', '');
    assert.equal(
      (await request('/accounts', 'POST', { login: name, password: f.password }, a)).status,
      201,
    );
    clients.push(await login(name, f.password));
  }
  const initial = await workspaceBase(a),
    extra = structuredClone(initial.data);
  extra.projects.push({ ...newProject(), name: '第三工地' }, { ...newProject(), name: '第四工地' });
  assert.equal(
    (await request('/workspace', 'PUT', { revision: initial.revision, data: extra }, a)).status,
    200,
  );
  const uniqueNotes: string[] = [];
  for (let round = 0; round < 6; round++) {
    const bases = await Promise.all(clients.map(workspaceBase));
    assert.equal(new Set(bases.map((s) => s.revision)).size, 1);
    const results = await Promise.all(
      clients.map((client, i) => {
        const nid = randomUUID();
        uniqueNotes.push(nid);
        return request(
          '/workspace',
          'PUT',
          submission(bases[i], (d) => {
            d.projects[i].notes = `人员${i}-轮次${round}`;
            d.notes.push({
              id: nid,
              projectId: d.projects[i].id,
              title: `记录${i}-${round}`,
              kind: '项目备忘',
              date: '',
              reminder: '',
              owner: '',
              content: '',
              done: false,
              pinned: false,
            });
          }),
          client,
        );
      }),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200, 200],
    );
  }
  const final = await workspaceBase(a);
  for (let i = 0; i < 4; i++) assert.equal(final.data.projects[i].notes, `人员${i}-轮次5`);
  assert.equal(final.data.notes.length, 25);
  assert.equal(new Set(final.data.notes.map((n: any) => n.id)).size, 25);
  assert.ok(uniqueNotes.every((id) => final.data.notes.some((n: any) => n.id === id)));
  for (const c of clients)
    assert.ok(final.history.records.some((r: any) => r.actorId === c.user.id));
});

test('workspace concurrency: a failed durable receipt rolls graph/history/completion back before an exact retry commits once', async () => {
  testClientIp = '203.0.113.215';
  const { a } = await seededWorkspace(),
    before = await workspaceBase(a);
  const body = submission(before, (d) => {
    d.purchases[0].status = '已完成';
    d.projects[0].notes = '必须与回执一起提交';
  });
  await assert.rejects(
    transaction(async (c) => {
      const query = (async (sql: string, values?: any[]) => {
        if (sql.includes('INSERT INTO audit_event') && values?.[3] === 'workspace.submit')
          throw Error('injected receipt failure after graph and business history');
        return c.query(sql, values);
      }) as pg.PoolClient['query'];
      return saveWorkspaceSubmission({ query }, a.user, body);
    }),
    /injected receipt failure/,
  );
  assert.deepEqual(await workspaceBase(a), before);
  const graph = await pool.query('SELECT payload FROM project WHERE workspace_id=$1 AND id=$2', [
    a.user.workspaceId,
    before.data.projects[0].id,
  ]);
  assert.deepEqual(graph.rows[0].payload, before.data.projects[0]);
  const completion = await pool.query(
    "SELECT count(*)::int n FROM purchase_action WHERE workspace_id=$1 AND operation='完成'",
    [a.user.workspaceId],
  );
  assert.equal(completion.rows[0].n, 0);
  const receipt = await pool.query(
    'SELECT count(*)::int n FROM audit_event WHERE workspace_id=$1 AND entity_id=$2',
    [a.user.workspaceId, body.requestId],
  );
  assert.equal(receipt.rows[0].n, 0);
  const retry = await request('/workspace', 'PUT', body, a);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).revision, before.revision + 1);
});

test('avatar: high-detail photo fits unchanged DB bound, duplicate concurrency is idempotent and independent workspace saves do not conflict', async () => {
  testClientIp = '203.0.113.216';
  const { a, b, f } = await seededWorkspace();
  const raw = Buffer.alloc(1080 * 1080 * 3);
  let seed = 314159;
  for (let i = 0; i < raw.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    raw[i] = seed >>> 24;
  }
  const png = await sharp(raw, { raw: { width: 1080, height: 1080, channels: 3 } })
    .png()
    .toBuffer();
  assert.ok(png.length > 524288);
  const before = await workspaceBase(a),
    body = {
      image: 'data:image/png;base64,' + png.toString('base64'),
      crop: { x: 10, y: 10, width: 1000, height: 700 },
    };
  const [photo, workspace] = await Promise.all([
    request('/auth/card-avatar', 'PUT', body, b),
    request(
      '/workspace',
      'PUT',
      submission(before, (d) => {
        d.projects[0].notes = '头像保存不参与全局CAS';
      }),
      a,
    ),
  ]);
  assert.equal(photo.status, 200, await photo.text());
  assert.equal(workspace.status, 200);
  const stored = await pool.query('SELECT png,version FROM card_avatar WHERE account_id=$1', [
    f.employeeId,
  ]);
  assert.ok(stored.rows[0].png.length <= 524288);
  const meta = await sharp(stored.rows[0].png).metadata();
  assert.equal(meta.width, 1000);
  assert.equal(meta.height, 700);
  const repeated = await Promise.all([
    request('/auth/card-avatar', 'PUT', body, b),
    request('/auth/card-avatar', 'PUT', body, b),
  ]);
  assert.deepEqual(
    repeated.map((r) => r.status),
    [200, 200],
  );
  const count = await pool.query(
    "SELECT count(*)::int n FROM audit_event WHERE workspace_id=$1 AND actor_id=$2 AND action='account.card-avatar'",
    [f.workspaceId, f.employeeId],
  );
  assert.equal(count.rows[0].n, 1);
  assert.equal((await workspaceBase(a)).revision, before.revision + 1);
  assert.equal(
    (await request('/auth/card-avatar', 'PUT', { ...body, crop: { ...body.crop, x: 1000 } }, b))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        '/auth/card-avatar',
        'PUT',
        { ...body, crop: { x: 0, y: 0, width: 1000, height: 1 } },
        b,
      )
    ).status,
    400,
  );
  assert.equal(
    (await pool.query('SELECT version FROM card_avatar WHERE account_id=$1', [f.employeeId]))
      .rows[0].version,
    stored.rows[0].version,
  );
});

test('trade colors and personnel order: real concurrent saves preserve fields, shared reads, audit history, dictionary references and competing order protection', async () => {
  testClientIp = '203.0.113.219';
  const { a, b, f } = await setup();
  const d = data();
  const first = d.people![0];
  d.people = [first, ...['乙', '丙', '丁'].map((name) => ({ ...first, id: randomUUID(), name }))];
  d.dictionaries = [
    { id: 'worker-old', kind: 'trade', label: '木工', active: true, order: 0 },
    { id: 'stage-old', kind: 'trade', label: '木工吊顶', active: true, order: 1 },
  ];
  d.people[0].tradeIds = ['worker-old', 'stage-old'];
  assert.equal((await request('/workspace', 'PUT', { revision: 0, data: d }, a)).status, 200);
  const [sa, sb] = await Promise.all([workspaceBase(a), workspaceBase(b)]);
  const results = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(sa, (x) => {
        x.trades[0].color = '#d65d42';
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(sb, (x) => {
        x.people = [x.people![3], ...x.people!.slice(0, 3)];
      }),
      b,
    ),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  const shared = await workspaceBase(b);
  assert.equal(shared.data.trades[0].color, '#d65d42');
  assert.deepEqual(
    shared.data.people!.map((p: { id: string }) => p.id),
    [d.people[3].id, ...d.people.slice(0, 3).map((p) => p.id)],
  );
  assert.deepEqual(shared.data.tasks, d.tasks);
  for (const p of shared.data.people!)
    assert.deepEqual(
      p,
      d.people.find((x) => x.id === p.id),
    );
  assert.deepEqual(shared.data.trades[0].staffIds, d.trades[0].staffIds);
  assert(
    shared.history.records.some((r: any) => r.changes.some((c: any) => c.label === '人员显示顺序')),
  );
  const freshLogin = await login(f.employee, f.password);
  assert.deepEqual((await workspaceBase(freshLogin)).data, shared.data);
  const [s1, s2] = await Promise.all([workspaceBase(a), workspaceBase(freshLogin)]);
  const competing = await Promise.all([
    request(
      '/workspace',
      'PUT',
      submission(s1, (x) => {
        const p = x.people!.pop()!;
        x.people!.unshift(p);
      }),
      a,
    ),
    request(
      '/workspace',
      'PUT',
      submission(s2, (x) => {
        const p = x.people!.splice(1, 1)[0];
        x.people!.unshift(p);
      }),
      freshLogin,
    ),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const failed = await competing.find((r) => r.status === 409)!.json();
  assert(failed.conflicts.some((c: any) => c.collection === 'people' && c.field === 'order'));
  const beforeBad = await workspaceBase(a);
  const invalid = submission(beforeBad, (x) => {
    x.dictionaries = [];
  });
  assert.equal((await request('/workspace', 'PUT', invalid, a)).status, 400);
  assert.deepEqual((await workspaceBase(a)).data, beforeBad.data);
});
