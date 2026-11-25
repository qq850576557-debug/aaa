const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const store = require('../owner-login/fixture-store');

test('formal package requires approved terms, protects the live route, and accepts an invitation without developer tools', async (t) => {
  const saved = { Page: global.Page, wx: global.wx };
  const sandbox = mkdtempSync(join(tmpdir(), 'owner-release-test-'));
  const root = join(sandbox, 'owner-login');
  cpSync(join(__dirname, '../owner-login'), root, { recursive: true });
  cpSync(join(__dirname, '../lib'), join(sandbox, 'lib'), { recursive: true });
  cpSync(join(__dirname, '../config.js'), join(sandbox, 'config.js'));
  writeFileSync(
    join(root, 'owner-live-config.js'),
    `module.exports = ${JSON.stringify({
      deployment: 'production',
      origin: 'https://chmsj.cn',
      appId: 'wx1111111111111111',
      terms: null,
    })};`,
  );
  t.after(() => {
    Object.assign(global, saved);
    rmSync(sandbox, { recursive: true, force: true });
  });
  const config = require(join(root, 'owner-live-config.js'));
  const productionStore = require(join(root, 'fixture-store.js'));
  let definition;
  const destinations = [];
  const calls = [];
  let modal;
  let appId = config.appId;
  let privacyOpened = false;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { appId, envVersion: 'release' } }),
    openPrivacyContract: () => {
      privacyOpened = true;
    },
    reLaunch: ({ url }) => destinations.push(url),
    navigateTo: ({ url }) => destinations.push(url),
    redirectTo: ({ url }) => destinations.push(url),
    showModal: (options) => {
      modal = options;
    },
    getStorageSync: (key) => {
      assert.equal(key, 'chunmo.owner.v1.production.session');
      return undefined;
    },
    setStorageSync: (key, value) => {
      if (key === 'chunmo.mini.entry.v1') assert.equal(value, 'owner');
      else assert.equal(key, 'chunmo.owner.v1.production.session');
    },
    login: async () => ({ code: 'fake-login-code' }),
    request: (input) => {
      calls.push(input);
      input.success({
        statusCode: 200,
        data: {
          token: 'd'.repeat(64),
          owner: { id: 'tester', name: '测试业主' },
          projects: [{ id: 'house', title: '测试住宅' }],
          purchasesEnabled: true,
        },
      });
    },
  };
  require(join(root, 'pages/welcome/index.js'));
  const load = () => {
    const page = { ...definition, data: structuredClone(definition.data) };
    page.setData = (patch) => Object.assign(page.data, patch);
    page.onLoad({ mode: 'review' });
    return page;
  };
  const closed = load();
  closed.toggleAgreement();
  closed.quickLogin();
  assert.equal(closed.data.live, false);
  assert.throws(() => productionStore.snapshot(), /重新进入/);
  assert.equal(calls.length, 0);
  config.terms = { version: 'test', text: '测试协议' };
  appId = 'wx2222222222222222';
  assert.equal(load().data.ready, false);
  appId = config.appId;
  const ready = load();
  await Promise.resolve();
  assert.equal(ready.data.live, true);
  assert.equal(ready.data.uiDev, false);
  ready.openEmployee();
  assert.equal(destinations.at(-1), '/pages/login/index?manual=1');
  ready.showPolicy({ currentTarget: { dataset: { title: '隐私保护指引' } } });
  assert.equal(privacyOpened, true);
  ready.showPolicy({ currentTarget: { dataset: { title: '用户协议' } } });
  assert.equal(destinations.at(-1), '/owner-login/pages/terms/index');
  ready.enterInvite();
  modal.success({ confirm: true, content: 'invalid' });
  assert.equal(ready.data.inviteReady, false);
  const invite = 'a'.repeat(64);
  modal.success({ confirm: true, content: ` ${invite} ` });
  assert.equal(ready.data.inviteReady, true);
  await ready.authorizePhone({ detail: { code: 'fake-phone-code' } });
  assert.equal(calls.length, 0);
  ready.toggleAgreement();
  await ready.authorizePhone({ detail: { code: 'fake-phone-code' } });
  assert.equal(calls[0].url, 'https://chmsj.cn/api/mini-owner/v1/auth/login');
  assert.equal(calls[0].data.invite, invite);
  assert.equal(ready.data.invite, '');
  assert.equal(productionStore.snapshot().project.id, 'house');
});

test('owner login preview separates both entry points and never attempts live authentication', (t) => {
  const saved = { Page: global.Page, wx: global.wx };
  const pages = ['welcome', 'employee', 'home', 'purchases', 'purchase', 'profile'].map(
    (name) => '../owner-login/pages/' + name + '/index',
  );
  t.after(() => {
    store.end();
    Object.assign(global, saved);
    pages.forEach((path) => delete require.cache[require.resolve(path)]);
  });
  let envVersion = 'develop';
  let definition;
  const destinations = [];
  const policies = [];
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {
    getWindowInfo: () => ({ statusBarHeight: 47 }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    reLaunch: ({ url }) => destinations.push(url),
    navigateTo: ({ url }) => destinations.push(url),
    redirectTo: ({ url, success }) => {
      destinations.push(url);
      success();
    },
    showToast() {},
    showModal: (options) => policies.push(options),
    hideKeyboard() {},
    login: () => assert.fail('Preview must not make a real login request'),
    request: () => assert.fail('Preview must not make a network request'),
    setStorageSync: () => assert.fail('Preview must not persist login data'),
  };
  function load(index) {
    delete require.cache[require.resolve(pages[index])];
    require(pages[index]);
    const page = { ...definition, data: structuredClone(definition.data) };
    page.setData = (patch) => Object.assign(page.data, patch);
    page.onLoad();
    return page;
  }
  const welcome = load(0);
  assert.equal(welcome.data.statusTop, 47);
  welcome.quickLogin();
  assert.match(welcome.data.feedback, /请先阅读/);
  welcome.toggleAgreement();
  assert.equal(welcome.data.agreed, true);
  welcome.quickLogin();
  assert.equal(destinations.at(-1), '/owner-login/pages/home/index');
  assert.equal(store.snapshot().project.id, 'demo-a');
  welcome.showPolicy({ currentTarget: { dataset: { title: '用户协议' } } });
  assert.equal(policies[0].title, '用户协议');
  welcome.openEmployee();
  assert.equal(destinations.at(-1), '/owner-login/pages/employee/index');

  const employee = load(1);
  employee.submit();
  assert.match(employee.data.feedback, /请填写/);
  employee.accountInput({ detail: { value: '测试员工' } });
  employee.focusPassword();
  assert.equal(employee.data.passwordFocused, true);
  employee.passwordInput({ detail: { value: 'preview-only' } });
  employee.togglePassword();
  assert.equal(employee.data.showPassword, true);
  employee.keyboardChange({ detail: { height: 311 } });
  assert.equal(employee.data.keyboardOpen, true);
  employee.submit();
  assert.equal(employee.data.password, '');
  assert.equal(employee.data.showPassword, false);
  assert.match(employee.data.feedback, /界面预览/);
  employee.passwordInput({ detail: { value: 'clear-on-background' } });
  employee.onHide();
  assert.equal(employee.data.account, '');
  assert.equal(employee.data.password, '');
  assert.equal(employee.data.keyboardOpen, false);

  store.end();
  assert.equal(load(2).data.ready, false);
  assert.equal(destinations.at(-1), '/owner-login/pages/welcome/index');
  store.begin();
  envVersion = 'release';
  for (const [index] of pages.entries()) {
    assert.equal(load(index).data.ready, false);
    assert.equal(destinations.at(-1), '/pages/login/index?manual=1');
  }
});

test('owner fixtures scope purchases, preserve edits, and gate status changes', (t) => {
  t.after(() => store.end());
  const now = Date.parse('2026-11-20T01:30:00Z');
  assert.equal(store.begin('denied', now), false);
  assert.throws(() => store.snapshot(), /重新进入/);
  store.begin('offline', now);
  assert.throws(() => store.snapshot(), /请重试/);
  store.retry();
  const { groups, project, projects } = store.snapshot();
  assert.equal(projects.length, 2);
  assert.deepEqual(
    groups.pending.map(({ id }) => id),
    ['lighting', 'tiles', 'hardware'],
  );
  const item = groups.pending[0];
  assert.equal(item.due, '2026-11-19');
  assert.equal(item.overdue, true);
  const feedback = {
    brand: ' 示例 ',
    model: 'CM-014',
    note: 'https://example.test/' + 'a'.repeat(360),
  };
  store.update(item.id, project.id, item.version, feedback);
  let change = store.snapshot().groups.bought.find(({ id }) => id === item.id);
  assert.equal(change.feedback.brand, '示例');
  assert.equal(change.feedback.note, feedback.note);
  assert.equal(change.overdue, false);
  assert.throws(() => store.update(item.id, project.id, item.version, feedback), /已更新/);
  store.update(item.id, project.id, change.version, { ...feedback, model: 'CM-015' });
  change = store.snapshot().groups.bought.find(({ id }) => id === item.id);
  assert.equal(change.feedback.model, 'CM-015');
  store.revoke(item.id, project.id, change.version);
  assert.equal(store.snapshot().groups.pending[0].id, item.id);
  const completed = groups.complete[0];
  assert.throws(
    () => store.update(completed.id, project.id, completed.version, feedback),
    /已确认到货/,
  );
  assert.throws(() => store.choose('other-project'), /不可访问/);
  store.choose(projects[1].id);
  assert.equal(store.snapshot().groups.pending[0].id, 'tile-b');
  assert.throws(() => store.update(item.id, project.id, item.version, feedback), /不可见/);
  store.begin('empty', now);
  assert.equal(store.snapshot().projects.length, 1);
  assert.deepEqual(store.snapshot().groups.pending, []);
});

test('verified owner reloads only the selected residence and retries the same feedback request', async (t) => {
  const api = require('../owner-login/owner-session');
  const backup = { session: api.session, purchases: api.purchases, feedback: api.feedback };
  t.after(() => {
    store.end();
    Object.assign(api, backup);
  });
  const owner = { id: 'owner', name: '测试业主' };
  const projects = [
    { id: 'a', title: '测试住宅 A', phase: '施工中' },
    { id: 'b', title: '测试住宅 B', phase: '施工中' },
  ];
  const feedback = { brand: 'A', model: 'M', note: 'https://example.com/item' };
  let replies = 0;
  let committed = false;
  const sends = [];
  const reads = [];
  api.session = async () => ({ owner, projects, purchasesEnabled: true });
  api.purchases = async (project) => {
    reads.push(project);
    return {
      items: [
        {
          id: project + '-item',
          title: '测试灯具',
          due: '2026-12-01',
          state: project === 'a' && committed ? 'bought' : 'pending',
          version: 'current',
          feedback,
        },
      ],
    };
  };
  api.feedback = async (project, id, payload) => {
    sends.push({ project, id, payload });
    committed = true;
    if (++replies === 1) throw Object.assign(Error('网络异常'), { statusCode: 0 });
    return { ok: true };
  };
  store.beginVerified({ owner, projects, purchasesEnabled: true });
  await Promise.all([store.refreshVerified(), store.refreshVerified()]);
  assert.deepEqual(reads, ['a']);
  await assert.rejects(() => store.update('a-item', 'a', 'current', feedback), /网络异常/);
  assert.equal(store.snapshot().groups.pending.length, 1);
  await store.update('a-item', 'a', 'current', feedback);
  assert.deepEqual(sends[0], sends[1]);
  await store.refreshVerified();
  assert.equal(store.snapshot().groups.bought[0].id, 'a-item');
  store.choose('b');
  await store.refreshVerified();
  assert.equal(store.snapshot().groups.pending[0].id, 'b-item');
  assert.throws(() => store.update('a-item', 'a', 'current', feedback), /不可见/);
  api.session = async () => {
    throw Object.assign(Error('授权已撤销'), { statusCode: 403 });
  };
  await assert.rejects(store.refreshVerified, /撤销/);
  assert.equal(store.isVerified(), false);
});

test('pulling down reloads the live purchase pages and clears withdrawn purchases', async (t) => {
  const api = require('../owner-login/owner-session');
  const { session, purchases } = api;
  const original = { Page: global.Page, wx: global.wx };
  const routes = ['home', 'purchases', 'purchase'];
  t.after(() => {
    Object.assign(api, { session, purchases });
    Object.assign(global, original);
    for (const route of routes)
      delete require.cache[require.resolve(`../owner-login/pages/${route}/index`)];
    store.end();
  });
  const auth = {
    owner: { id: 'owner', name: '测试业主' },
    projects: [{ id: 'a', title: '测试住宅' }],
    purchasesEnabled: true,
  };
  const item = { id: 'lamp', title: '灯具', state: 'pending', due: '2026-12-01' };
  let stopped = 0;
  let definition;
  global.wx = { stopPullDownRefresh: () => stopped++ };
  global.Page = (value) => {
    definition = value;
  };
  api.session = async () => auth;
  api.purchases = async () => ({ items: [item] });
  store.beginVerified(auth);
  const pages = routes.map((route) => {
    const path = `../owner-login/pages/${route}/index`;
    delete require.cache[require.resolve(path)];
    require(path);
    return {
      ...definition,
      data: { ...definition.data, ready: true, id: item.id },
      setData(patch) {
        Object.assign(this.data, patch);
      },
    };
  });
  for (const page of pages) await page.onShow();
  assert.equal(pages[0].data.pendingCount, 1);
  assert.equal(pages[1].data.rows.length, 1);
  assert.equal(pages[2].data.item.id, item.id);
  api.purchases = async () => ({ items: [] });
  for (const page of pages) await page.onPullDownRefresh();
  assert.equal(stopped, 3);
  assert.equal(pages[0].data.pendingCount, 0);
  assert.equal(pages[1].data.rows.length, 0);
  assert.equal(pages[2].data.unavailable, true);
});

test('purchase sheet keeps the selected image through the picker and a network retry, then clears private previews on hide', async (t) => {
  const api = require('../owner-login/owner-session');
  const backup = { feedback: api.feedback, session: api.session, purchases: api.purchases };
  const original = { Page: global.Page, wx: global.wx, photo: store.photo };
  const path = '../owner-login/pages/purchase/index';
  t.after(() => {
    global.Page = original.Page;
    global.wx = original.wx;
    store.photo = original.photo;
    Object.assign(api, backup);
    delete require.cache[require.resolve(path)];
    store.end();
  });
  const identity = {
    owner: { id: 'test', name: '测试业主' },
    projects: [{ id: 'home', title: '测试住宅' }],
    purchasesEnabled: true,
  };
  const imageId = 'a'.repeat(64);
  const item = {
    id: 'lamp',
    title: '灯具',
    state: 'bought',
    version: 'v',
    due: '2026-12-01',
    feedback: { brand: 'A', model: 'B', note: '', imageId },
  };
  const requests = [];
  let definition,
    page,
    fileReads = 0;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {
    showToast() {},
    chooseMedia: async () => {
      page.onHide();
      await page.onShow();
      return { tempFiles: [{ tempFilePath: '/temp/photo.png' }] };
    },
    getFileSystemManager: () => ({
      statSync: () => ({ size: 1024 }),
      readFile: ({ success }) => {
        fileReads++;
        success({ data: 'dGVzdA==' });
      },
    }),
  };
  api.session = async () => identity;
  api.purchases = async () => ({ items: [item] });
  api.feedback = async (project, id, value) => {
    requests.push({ project, id, value });
    if (requests.length === 1) throw Object.assign(Error('网络中断'), { statusCode: 0 });
  };
  store.photo = async (project, id, digest) => {
    assert.deepEqual([project, id, digest], ['home', 'lamp', imageId]);
    return { image: 'dGVzdA==' };
  };
  store.beginVerified(identity);
  delete require.cache[require.resolve(path)];
  require(path);
  page = {
    ...definition,
    data: { ...definition.data, ready: true, id: 'lamp' },
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  await page.onShow();
  await page.showPhoto();
  assert.match(page.data.photoSrc, /^data:image\/jpeg;base64,/);
  page.onHide();
  assert.equal(page.data.photoSrc, '');
  await page.onShow();
  page.openSheet();
  await page.choosePhoto();
  assert.equal(page.data.sheet, true);
  assert.equal(page.data.photoState, 'new');
  page.data.draft.link = 'https://example.com/item';
  await page.saveVerified('purchase', page.data.item, page.data.project, page.data.draft);
  assert.equal(page.data.draftError, '网络中断');
  await page.saveVerified('purchase', page.data.item, page.data.project, page.data.draft);
  assert.equal(fileReads, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].value.feedback.link, 'https://example.com/item');
  assert.equal(requests[0].value.feedback.image, 'dGVzdA==');
  assert.equal(page.data.sheet, false);
});
