const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkbenchClient } = require('../lib/workbench-client');
function fixture() {
  const disk = new Map();
  let calls = [],
    offline = false,
    conflict = false,
    quota = false;
  const api = {
    identity: { id: 'actor-a', workspaceId: 'studio', name: '测试' },
    request: async (path, body, method) => {
      if (path === 'session') return { user: api.identity };
      calls.push({ path, body, method });
      if (offline) throw Error('offline');
      if (conflict) throw Object.assign(Error('conflict'), { status: 409 });
      return { id: 'saved', version: 1 };
    },
  };
  const storage = {
    get: (k) => structuredClone(disk.get(k)),
    set: (k, v) => {
      if (quota) throw Error('quota');
      disk.set(k, structuredClone(v));
    },
  };
  return {
    api,
    storage,
    disk,
    calls,
    setOffline: (v) => (offline = v),
    setConflict: (v) => (conflict = v),
    setQuota: (v) => (quota = v),
  };
}
test('offline mutation survives restart with same requestId; only server confirmation removes it', async () => {
  const f = fixture();
  let c = new WorkbenchClient(f.api, f.storage);
  c.enqueue(
    'workbench/records',
    'POST',
    { requestId: 'fixed', value: { title: '草稿' } },
    'record:fixed',
  );
  f.setOffline(true);
  await assert.rejects(c.flush(), /offline/);
  c = new WorkbenchClient(f.api, f.storage);
  assert.equal(c.pending.length, 1);
  f.setOffline(false);
  await Promise.all([c.flush(), c.flush()]);
  assert.equal(c.pending.length, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.requestId, f.calls[1].body.requestId);
});
test('conflict cannot automatically retry or overwrite another actor; archived draft stays available', async () => {
  const f = fixture(),
    c = new WorkbenchClient(f.api, f.storage);
  c.enqueue('workbench/records/x', 'PUT', { requestId: 'x' }, 'record:x');
  f.setConflict(true);
  await assert.rejects(c.flush());
  assert.ok(c.pending[0].blocked);
  f.setConflict(false);
  await assert.rejects(c.flush());
  assert.equal(f.calls.length, 1);
  c.archiveBlocked(0);
  assert.equal(c.archive.length, 1);
  assert.equal(c.pending.length, 0);
  f.api.identity = { id: 'actor-b', workspaceId: 'studio', name: '另一个' };
  await assert.rejects(c.flush(), /账号/);
  const b = new WorkbenchClient(f.api, f.storage);
  assert.equal(b.archive.length, 0);
});
test('quota failure prevents network mutation; separate form drafts survive restart', () => {
  const f = fixture(),
    c = new WorkbenchClient(f.api, f.storage);
  f.setQuota(true);
  assert.throws(
    () => c.enqueue('workbench/records', 'POST', { requestId: 'x' }, 'record:x'),
    /quota/,
  );
  assert.equal(c.pending.length, 0);
  assert.equal(f.calls.length, 0);
  f.setQuota(false);
  c.saveDraft({ kind: 'record', id: 'a', form: { title: '甲' } });
  c.saveDraft({ kind: 'record', id: 'b', form: { title: '乙' } });
  const again = new WorkbenchClient(f.api, f.storage);
  assert.equal(Object.keys(again.drafts).length, 2);
});
test('invalid confirmation never removes a queued record; retry keeps the original payload', async () => {
  const f = fixture(),
    c = new WorkbenchClient(f.api, f.storage);
  c.enqueue(
    'workbench/records',
    'POST',
    { requestId: 'same-id', value: { title: '未确认' } },
    'record:same-id',
  );
  const real = f.api.request;
  f.api.request = async (path, ...args) =>
    path === 'session' ? real(path, ...args) : 'website html';
  await assert.rejects(c.flush(), /回执/);
  assert.equal(c.pending[0].body.requestId, 'same-id');
});
test('account change during wx bootstrap cannot send the prior account mutation', async () => {
  const { Api } = require('../lib/api');
  const api = new Api();
  let sent = false;
  api.identity = { id: 'a', workspaceId: 'studio' };
  api.bootstrap = async () => {
    api.identity = { id: 'b', workspaceId: 'studio' };
  };
  api.raw = async () => {
    sent = true;
    return {};
  };
  await assert.rejects(
    api.request('workbench/records', { requestId: 'held' }, 'POST'),
    (e) => e.code === 'OWNER_CHANGED',
  );
  assert.equal(sent, false);
});
test('account change during expired-proof refresh also cannot send the prior mutation', async () => {
  const { Api } = require('../lib/api');
  const api = new Api();
  let raw = 0,
    boot = 0;
  api.identity = { id: 'a', workspaceId: 'studio' };
  api.bootstrap = async () => {
    if (++boot === 2) api.identity = { id: 'b', workspaceId: 'studio' };
  };
  api.raw = async () => {
    raw++;
    throw Object.assign(Error('expired'), { code: 'MINI_PROOF_EXPIRED' });
  };
  await assert.rejects(
    api.request('workbench/records', { requestId: 'held' }, 'POST'),
    (e) => e.code === 'OWNER_CHANGED',
  );
  assert.equal(raw, 1);
});
