import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from './app';
import { fixtureAccounts, fixtureQuery } from './test-fixtures';
import { config } from './config';
import { pool, privatePool } from './db';
import { plus } from '../src/lib/model';
import { emptyStudio, studioDay } from '../src/lib/studio-daily';
const server = createServer(createApp());
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + (server.address() as any).port;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await privatePool.end();
});
async function req(path: string, method = 'GET', body?: unknown, a?: any) {
  return fetch(url + '/api' + path, {
    method,
    headers: {
      Origin: config.APP_ORIGIN,
      'Content-Type': 'application/json',
      ...(a ? { cookie: a.cookie, 'X-CSRF-Token': a.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function login(name: string, password: string) {
  const r = await req('/auth/login', 'POST', { login: name, password });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const s = await (await req('/auth/session', 'GET', undefined, { cookie, csrf: '' })).json();
  return { cookie, csrf: s.csrf };
}
test('studio settings persist, scope assignments, enforce owner/CSRF/CAS, deduplicate and isolate studios', async () => {
  const f = await fixtureAccounts(2),
    owner = await login(f.login, f.password),
    staff = await login(f.employee, f.password),
    other = await login(f.employees[1].login, f.password);
  let r = await req('/studio-daily', 'GET', undefined, owner);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, 0);
  const value = emptyStudio();
  value.rules = [
    {
      id: randomUUID(),
      text: '隔离测试要求',
      enabled: true,
      people: [f.employeeId],
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      from: '',
      to: '',
    },
  ];
  value.weekly[new Date(studioDay() + 'T12:00Z').getUTCDay()] = [f.employeeId];
  const b = { requestId: randomUUID(), version: 0, value };
  r = await req('/studio-daily', 'PUT', b, staff);
  assert.equal(r.status, 403);
  assert.equal((await req('/studio-daily', 'PUT', b, { ...owner, csrf: 'bad' })).status, 403);
  r = await req('/studio-daily', 'PUT', b, owner);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, 1);
  assert.equal((await (await req('/studio-daily', 'PUT', b, owner)).json()).version, 1);
  assert.equal(
    (await req('/studio-daily', 'PUT', { ...b, requestId: randomUUID() }, owner)).status,
    409,
  );
  assert.equal(
    (await (await req('/studio-daily', 'GET', undefined, staff)).json()).value.rules.length,
    1,
  );
  assert.equal(
    (await (await req('/studio-daily', 'GET', undefined, other)).json()).value.rules.length,
    0,
  );
  const g = await fixtureAccounts(),
    outside = await login(g.login, g.password);
  assert.equal(
    (await (await req('/studio-daily', 'GET', undefined, outside)).json()).value.rules.length,
    0,
  );
  assert.equal(
    (
      await req(
        '/studio-daily',
        'PUT',
        {
          requestId: randomUUID(),
          version: 1,
          value: { ...value, weekly: [[g.employeeId], [], [], [], [], [], []] },
        },
        owner,
      )
    ).status,
    400,
  );
});

test('rotation owner-only commands append completion and corrections; legacy settings cannot erase history', async () => {
  const f = await fixtureAccounts(),
    a = await login(f.login, f.password),
    s = await login(f.employee, f.password);
  const day = studioDay(),
    anchor = plus(day, -7),
    planned = plus(anchor, 6);
  const configure = {
    requestId: randomUUID(),
    version: 0,
    value: {
      action: 'configure',
      interval: 3,
      people: [f.employeeId],
      start: anchor,
      currentDate: anchor,
    },
  };
  // Resolve account IDs from the same directory used by the desktop UI.
  const current = await (await req('/studio-daily', 'GET', undefined, a)).json();
  configure.value.people = [f.employeeId, f.id];
  assert.equal(current.day, day);
  assert.equal(studioDay(current.serverTime), day);
  assert.equal((await req('/studio-daily/rotation', 'POST', configure, s)).status, 403);
  assert.equal((await req('/studio-daily/rotation', 'POST', configure, a)).status, 200);
  const complete = {
    requestId: randomUUID(),
    version: 1,
    value: {
      action: 'complete',
      actual: day,
      reschedule: false,
      round: { person: f.employeeId, planned },
    },
  };
  const before = await (await req('/studio-daily', 'GET', undefined, a)).json();
  assert.equal(before.value.rotation.currentDate, anchor);
  assert.equal(before.value.rotation.history.length, 0);
  const stale = {
    ...complete,
    requestId: randomUUID(),
    value: { ...complete.value, round: { person: f.employeeId, planned: anchor } },
  };
  assert.equal((await req('/studio-daily/rotation', 'POST', stale, a)).status, 409);
  assert.equal((await req('/studio-daily/rotation', 'POST', complete, s)).status, 403);
  const competing = { ...complete, requestId: randomUUID() };
  const attempts = await Promise.all(
    [complete, competing].map((body) => req('/studio-daily/rotation', 'POST', body, a)),
  );
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const winner = attempts[0].status === 200 ? complete : competing;
  assert.equal((await req('/studio-daily/rotation', 'POST', winner, a)).status, 200);
  assert.equal(
    (await req('/studio-daily/rotation', 'POST', { ...complete, requestId: randomUUID() }, a))
      .status,
    409,
  );
  let saved = await (await req('/studio-daily', 'GET', undefined, a)).json();
  assert.equal(saved.value.rotation.history.length, 1);
  assert.equal(saved.value.rotation.currentDate, plus(planned, 3));
  assert.equal(saved.value.rotation.history[0].person, f.employeeId);
  assert.equal(saved.value.rotation.history[0].planned, planned);
  assert.equal(saved.value.rotation.history[0].actual, day);
  const original = structuredClone(saved.value.rotation.history);
  assert.equal(
    (
      await req(
        '/studio-daily/rotation',
        'POST',
        {
          requestId: randomUUID(),
          version: 2,
          value: { action: 'correctLast', actual: day, roundId: original[0].id, reschedule: true },
        },
        a,
      )
    ).status,
    200,
  );
  saved = await (await req('/studio-daily', 'GET', undefined, a)).json();
  assert.deepEqual(saved.value.rotation.history, original);
  assert.equal(saved.value.rotation.currentDate, plus(day, 3));
  const legacy = { ...saved.value };
  delete legacy.rotation;
  assert.equal(
    (await req('/studio-daily', 'PUT', { requestId: randomUUID(), version: 3, value: legacy }, a))
      .status,
    200,
  );
  saved = await (await req('/studio-daily', 'GET', undefined, a)).json();
  assert.deepEqual(saved.value.rotation.history, original);
  assert.equal(
    (
      await req(
        '/studio-daily',
        'PUT',
        {
          requestId: randomUUID(),
          version: 4,
          value: { ...saved.value, rotation: { ...saved.value.rotation, history: [] } },
        },
        a,
      )
    ).status,
    400,
  );
});

test('a role label cannot grant founder permissions and editing text preserves legacy schedule fields', async () => {
  const f = await fixtureAccounts();
  // This guarded helper only connects to the dedicated localhost *_test database.
  await fixtureQuery("UPDATE account SET role='owner' WHERE id=$1", [f.employeeId]);
  const staff = await login(f.employee, f.password),
    founder = await login(f.login, f.password);
  assert.equal((await (await req('/studio-daily', 'GET', undefined, staff)).json()).owner, false);
  const value = emptyStudio();
  value.rules = [
    {
      id: randomUUID(),
      text: '旧要求',
      enabled: false,
      people: [],
      weekdays: [1, 3],
      from: '2026-01-01',
      to: '2026-12-31',
    },
  ];
  value.weekly[1] = [f.employeeId];
  value.exceptions = [{ date: '2026-11-16', people: [] }];
  value.cleaning = '保留旧说明';
  const put = { requestId: randomUUID(), version: 0, value };
  assert.equal((await req('/studio-daily', 'PUT', put, staff)).status, 403);
  assert.equal(
    (
      await req(
        '/studio-daily/rotation',
        'POST',
        {
          requestId: randomUUID(),
          version: 0,
          value: { action: 'complete', actual: '2026-11-15' },
        },
        staff,
      )
    ).status,
    403,
  );
  assert.equal((await req('/studio-daily', 'PUT', put, founder)).status, 200);
  value.rules[0].text = '修改工作要求文字';
  assert.equal(
    (await req('/studio-daily', 'PUT', { requestId: randomUUID(), version: 1, value }, founder))
      .status,
    200,
  );
  const saved = await (await req('/studio-daily', 'GET', undefined, founder)).json();
  assert.deepEqual(saved.value, value);
});
