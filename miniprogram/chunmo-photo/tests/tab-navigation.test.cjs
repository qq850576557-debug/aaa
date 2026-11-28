const { test } = require('node:test');
const assert = require('node:assert/strict');

test('employee native tab lifecycles share each read and retain filter and data across twenty switches', async (t) => {
  const saved = { Page: global.Page, wx: global.wx, getApp: global.getApp, getCurrentPages: global.getCurrentPages };
  const identity = { workspaceId: 'test', id: 'employee-nav', name: '员工' };
  let definition;
  let focused;
  let revoked = false;
  let offline = false;
  const calls = { workspace: 0, profile: 0, avatar: 0, photo: 0, refreshed: 0, documents: 0 };
  const routes = [];
  const quietFailure = () => {
    if (revoked) throw Object.assign(Error('已撤销'), { status: 401 });
    if (offline) throw Error('网络超时');
  };
  const api = {
    identity,
    async request() { calls.photo++; quietFailure(); return {}; },
    async personalProfile() { calls.profile++; quietFailure(); return { name: '林工', department: '工程部' }; },
    async personalAvatar() { calls.avatar++; quietFailure(); return Uint8Array.of(1, 2, 3).buffer; },
  };
  const state = { data: { projects: [], trades: [], tasks: [], purchases: [], notes: [] } };
  const workbench = {
    api, actor: identity, state: null, records: [], pending: [], archive: [],
    async flush() {},
    async refresh() { calls.workspace++; quietFailure(); this.state = state; },
  };
  const app = { api, workbench, foreground: 1, engine: { store: { identity }, stats: () => ({ pending: 2, failed: 0 }) } };
  global.Page = (page) => { definition = page; };
  global.getApp = () => app;
  global.getCurrentPages = () => [focused];
  global.wx = {
    env: { USER_DATA_PATH: '/test' },
    getStorageSync: () => undefined,
    reLaunch: ({ url }) => routes.push(url),
    stopPullDownRefresh: () => calls.refreshed++,
    getFileSystemManager: () => ({
      writeFile: ({ success }) => { calls.documents++; success(); },
      unlink() {},
    }),
  };
  const paths = ['workbench', 'photo', 'me'].map((tab) => require.resolve('../pages/' + tab + '/index'));
  const [work, photo, me] = paths.map((path) => {
    delete require.cache[path];
    require(path);
    const page = { ...definition, data: structuredClone(definition.data) };
    page.setData = (patch) => {
      for (const [name, value] of Object.entries(patch)) {
        const [key, field] = name.split('.');
        if (field) page.data[key][field] = value;
        else page.data[key] = value;
      }
    };
    page.onLoad?.();
    return page;
  });
  t.after(() => {
    paths.forEach((path) => delete require.cache[path]);
    Object.assign(global, saved);
  });
  const show = async (page) => {
    focused?.onHide?.();
    focused = page;
    await page.onShow();
  };
  await show(work);
  work.tab({ currentTarget: { dataset: { key: 'purchases' } } });
  await show(photo);
  await show(me);
  const avatar = me.data.profile.avatar;
  for (let i = 0; i < 20; i++) {
    await show([work, photo, me][i % 3]);
    assert.equal(work.data.tab, 'purchases');
    assert.equal(work.data.busy, false);
    assert.equal(me.data.subtitle, '工程部');
    assert.equal(me.data.profile.avatar, avatar);
    assert.equal(photo.data.pending, 2);
  }
  assert.deepEqual(calls, { workspace: 1, profile: 1, avatar: 1, photo: 1, refreshed: 0, documents: 1 });
  offline = true;
  app.foreground++;
  await show(work);
  await show(me);
  assert.equal(workbench.state, state);
  assert.equal(me.data.profile.avatar, avatar);
  offline = false;
  await me.onPullDownRefresh();
  assert.equal(calls.refreshed, 1);
  assert.equal(calls.documents, 1);
  revoked = true;
  app.foreground++;
  await show(work);
  assert.deepEqual(work.data.items, []);
  assert.equal(workbench.state, null);
  await show(me);
  assert.equal(me.data.profile, null);
  await show(photo);
  assert.equal(photo.data.pending, 0);
  assert.equal(routes.at(-1), '/owner-login/pages/welcome/index');
});
