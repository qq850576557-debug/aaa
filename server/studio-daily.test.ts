import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from './app';
import { fixtureAccounts } from './test-fixtures';
import { config } from './config';
import { pool, privatePool } from './db';
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
