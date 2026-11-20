const { test } = require('node:test');
const assert = require('node:assert/strict');

test('owner login preview separates both entry points and never attempts live authentication', (t) => {
  const saved = { Page: global.Page, wx: global.wx };
  const pages = ['../owner-login/pages/welcome/index', '../owner-login/pages/employee/index'];
  t.after(() => {
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
  assert.match(welcome.data.feedback, /后续阶段接入/);
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

  envVersion = 'release';
  assert.equal(load(0).data.ready, false);
  assert.equal(load(1).data.ready, false);
  assert.deepEqual(destinations.slice(-2), ['/pages/login/index', '/pages/login/index']);
});
