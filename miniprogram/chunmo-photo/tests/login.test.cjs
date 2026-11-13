const { test } = require('node:test');
const assert = require('node:assert/strict');
const session = require('../lib/session');

test('separate account/password pages keep Chinese account text and existing authentication flow', async (t) => {
  const before = { wx: global.wx, Page: global.Page, getApp: global.getApp, enter: session.enter };
  const files = ['../pages/login/index', '../pages/password/index'];
  t.after(() => {
    Object.assign(global, { wx: before.wx, Page: before.Page, getApp: before.getApp });
    session.enter = before.enter;
    files.forEach((f) => delete require.cache[require.resolve(f)]);
  });
  let page,
    authCalls = 0,
    denied = false;
  const routes = [];
  const app = {
    api: {
      login: async (account, password) => {
        authCalls++;
        assert.equal(account, '春茉设计');
        assert.equal(password, 'test-only-password');
        if (denied) throw Error('账号或密码错误');
        return { id: 'test-actor' };
      },
    },
  };
  global.getApp = () => app;
  global.Page = (definition) => {
    page = definition;
    page.data = structuredClone(page.data);
    page.setData = (patch) => Object.assign(page.data, patch);
  };
  global.wx = {
    hideKeyboard() {},
    requirePrivacyAuthorize: (o) => o.success({}),
    redirectTo: (o) => {
      routes.push(o.url);
      if (o.success) o.success({});
    },
  };
  let entered = 0;
  session.enter = async () => {
    entered++;
    return { list: () => [] };
  };
  function load(file) {
    delete require.cache[require.resolve(file)];
    require(file);
    page.onLoad();
  }
  load(files[0]);
  await page.next();
  assert.equal(authCalls, 0);
  assert.equal(routes.length, 0);
  page.accountInput({ detail: { value: ' 春茉设计\n' } });
  await page.next();
  assert.equal(app.pendingLogin, '春茉设计');
  assert.equal(authCalls, 0);
  assert.equal(routes.at(-1), '/pages/password/index');
  assert.ok(!routes.some((r) => r.includes('春茉设计')));
  load(files[1]);
  page.passwordInput({ detail: { value: 'must-clear-on-hide' } });
  page.onHide();
  assert.equal(page.data.password, '');
  denied = true;
  page.passwordInput({ detail: { value: 'test-only-password' } });
  await page.submit();
  assert.equal(entered, 0);
  assert.equal(page.data.password, '');
  assert.match(page.data.error, /账号或密码错误/);
  await page.changeAccount();
  assert.equal(routes.at(-1), '/pages/login/index');
  load(files[0]);
  assert.equal(page.data.login, '春茉设计');
  await page.next();
  load(files[1]);
  denied = false;
  page.passwordInput({ detail: { value: 'test-only-password' } });
  await page.submit();
  assert.equal(entered, 1);
  assert.equal(app.pendingLogin, '');
  assert.equal(routes.at(-1), '/pages/places/index');
  app.pendingLogin = '';
  load(files[1]);
  assert.equal(routes.at(-1), '/pages/login/index');
});
