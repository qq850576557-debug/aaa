import { pathToFileURL } from 'node:url';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from './app';
import { createMiniPhotoSidecar } from './miniprogram-sidecar';
import { config } from './config';
import { pool, privatePool } from './db';
import { fixtureAccounts, fixtureQuery } from './test-fixtures';
import { emptyData, newProject, today } from '../src/lib/model';
import { planPurchase } from '../src/lib/mini-workbench';
import { Api, WorkbenchClient, miniRuntime } from '../tests/support/mini-runtime';
let apiServer: Server, miniServer: Server, base: string, restore: () => void;
let legacy: any;
const appId = 'wx1234567890abcdef';
before(async () => {
  if (config.APP_ENV !== 'test') throw Error('Only isolated test DB permitted');
  legacy = process.env.CHUNMO_LEGACY_APP_BUNDLE
    ? await import(pathToFileURL(process.env.CHUNMO_LEGACY_APP_BUNDLE).href)
    : null;
  apiServer = createServer(legacy ? legacy.createApp() : createApp());
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  const port = (apiServer.address() as any).port;
  base = 'http://127.0.0.1:' + port;
  miniServer = createServer(
    createMiniPhotoSidecar({
      enabled: true,
      workbenchEnabled: true,
      appId,
      appSecret: 'synthetic',
      signingKey: 'synthetic-key-'.repeat(5),
      origin: config.APP_ORIGIN,
      apiPort: port,
      exchange: async () => ({ openid: 'test-only' }),
    }),
  );
  await new Promise<void>((r) => miniServer.listen(0, '127.0.0.1', r));
  restore = miniRuntime('http://127.0.0.1:' + (miniServer.address() as any).port, appId);
});
after(async () => {
  restore?.();
  for (const s of [miniServer, apiServer])
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  await pool.end();
  await privatePool.end();
  if (legacy) {
    await legacy.pool.end();
    await legacy.privatePool.end();
  }
});
async function pc(path: string, method = 'GET', body?: unknown, actor?: any) {
  return fetch(base + '/api' + path, {
    method,
    headers: {
      Origin: config.APP_ORIGIN,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(actor ? { cookie: actor.cookie, 'X-CSRF-Token': actor.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function desktop(login: string, password: string) {
  const r = await pc('/auth/login', 'POST', { login, password });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const s = await (await pc('/auth/session', 'GET', undefined, { cookie, csrf: '' })).json();
  return { cookie, csrf: s.csrf };
}
test('real desktop API → actual Mini client reads → Mini updates → desktop same record, receipts, conflicts and studio isolation', async () => {
  const f = await fixtureAccounts(),
    a = await desktop(f.login, f.password),
    data = emptyData(),
    p = { ...newProject(), name: '隔离工地' };
  data.projects = [p];
  assert.equal((await pc('/workspace', 'PUT', { revision: 0, data }, a)).status, 200);
  let state = await (await pc('/workspace', 'GET', undefined, a)).json();
  const id = randomUUID(),
    create = planPurchase(
      state,
      {
        projectId: p.id,
        name: '跨端材料',
        due: today(),
        status: '待采购',
        owner: '测试负责人',
        notes: '',
      },
      randomUUID(),
      id,
    );
  assert.equal((await pc('/workspace', 'PUT', create, a)).status, 200);
  const api = new Api();
  await api.login(f.employee, f.password);
  const disk = new Map();
  const storage = {
    get: (k: string) => structuredClone(disk.get(k)),
    set: (k: string, v: unknown) => disk.set(k, structuredClone(v)),
  };
  let client = new WorkbenchClient(api, storage);
  await client.refresh();
  assert.equal(client.state.data.purchases[0].id, id);
  client.purchase({ status: '已下单' }, id);
  await client.flush();
  state = await (await pc('/workspace', 'GET', undefined, a)).json();
  assert.equal(state.data.purchases.length, 1);
  assert.equal(state.data.purchases[0].status, '已下单');
  assert.deepEqual(
    state.data.projects.map(({ updatedAt, ...x }: any) => x),
    data.projects.map(({ updatedAt, ...x }: any) => x),
  );
  await client.refresh();
  client.purchase({ notes: '丢失回执测试' }, id);
  const real = api.request.bind(api);
  let lose = true;
  api.request = async (...args: any[]) => {
    const result = await real(...args);
    if (args[2] === 'PUT' && lose) {
      lose = false;
      throw Error('response lost');
    }
    return result;
  };
  await assert.rejects(client.flush(), /response lost/);
  const requestId = client.pending[0].body.requestId;
  client = new WorkbenchClient(api, storage);
  await client.flush();
  assert.equal(client.pending.length, 0);
  const receipts = await fixtureQuery(
    "SELECT count(*)::int AS n FROM audit_event WHERE workspace_id=$1 AND entity_id=$2 AND action='workspace.submit'",
    [f.workspaceId, requestId],
  );
  assert.equal(receipts.rows[0].n, 1);
  await client.refresh();
  const stale = client.state;
  state = await (await pc('/workspace', 'GET', undefined, a)).json();
  assert.equal(
    (
      await pc(
        '/workspace',
        'PUT',
        planPurchase(state, { name: '电脑后提交' }, randomUUID(), id),
        a,
      )
    ).status,
    200,
  );
  client.purchase({ name: '手机旧版本' }, id, stale);
  await assert.rejects(client.flush(), (e: any) => e.status === 409);
  assert.ok(client.pending[0].blocked);
  state = await (await pc('/workspace', 'GET', undefined, a)).json();
  assert.equal(state.data.purchases[0].name, '电脑后提交');
  const invalid = await api
    .request(
      'workbench/workspace',
      {
        protocol: 3,
        revision: state.revision,
        requestId: randomUUID(),
        changes: [
          {
            collection: 'projects',
            kind: 'record',
            id: p.id,
            before: p,
            after: { ...p, name: '禁止改项目' },
          },
        ],
      },
      'PUT',
    )
    .then(
      () => 200,
      (e: any) => e.status,
    );
  assert.equal(invalid, 400);
  const proof = planPurchase(state, { status: '已完成' }, randomUUID(), id);
  assert.equal(
    await api.request('workbench/workspace', proof, 'PUT').then(
      () => 200,
      (e: any) => e.status,
    ),
    403,
  ); // owner proof cannot be reused by employee
  const csrf = api.csrf;
  api.csrf = 'bad';
  assert.equal(
    await api.request('workbench/records', { requestId: randomUUID(), value: {} }, 'POST').then(
      () => 200,
      (e: any) => e.status,
    ),
    403,
  );
  api.csrf = csrf;
  const other = await fixtureAccounts();
  const b = new Api();
  await b.login(other.employee, other.password);
  const outsider = new WorkbenchClient(b, { get: () => undefined, set: () => {} });
  await outsider.refresh();
  assert.ok(!outsider.state.data.projects.some((x: any) => x.id === p.id));
  await api.request('logout', {});
  assert.equal(
    await api.request('workbench/workspace').then(
      () => 200,
      (e: any) => e.status,
    ),
    401,
  );
});
test('record writes use original version, history, duplicate receipt and no alternate table', async () => {
  const f = await fixtureAccounts(),
    a = await desktop(f.login, f.password),
    data = emptyData(),
    p = { ...newProject(), name: '事项测试工地' };
  data.projects = [p];
  assert.equal((await pc('/workspace', 'PUT', { revision: 0, data }, a)).status, 200);
  const api = new Api();
  await api.login(f.employee, f.password);
  const client = new WorkbenchClient(api, { get: () => undefined, set: () => {} });
  await client.refresh();
  const value = {
    projectId: p.id,
    title: '小程序事项',
    nodeDate: today(),
    status: '持续跟进',
    owner: '测试',
    notes: '备注',
    followUp: '跟进',
  };
  client.record(value);
  const body = client.pending[0].body;
  await client.flush();
  await api.request('workbench/records', body, 'POST');
  await client.refresh();
  assert.equal(client.records.length, 1);
  const old = client.records[0];
  client.record({ ...value, status: '已完成' }, old);
  await client.flush();
  const records = await (await pc('/records', 'GET', undefined, a)).json();
  assert.equal(records.records[0].status, '已完成');
  const h = await api.request('workbench/records/' + old.id + '/history');
  assert.equal(h.events.length, 2);
  client.record({ ...value, notes: '旧版本不能覆盖' }, old);
  await assert.rejects(client.flush(), (e: any) => e.status === 409);
});
