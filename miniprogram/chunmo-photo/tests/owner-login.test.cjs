const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../owner-login/fixture-store');

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
    assert.equal(destinations.at(-1), '/pages/login/index');
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
    /已确认完成/,
  );
  assert.throws(() => store.choose('other-project'), /不可访问/);
  store.choose(projects[1].id);
  assert.equal(store.snapshot().groups.pending[0].id, 'tile-b');
  assert.throws(() => store.update(item.id, project.id, item.version, feedback), /不可见/);
  store.begin('empty', now);
  assert.equal(store.snapshot().projects.length, 1);
  assert.deepEqual(store.snapshot().groups.pending, []);
});
