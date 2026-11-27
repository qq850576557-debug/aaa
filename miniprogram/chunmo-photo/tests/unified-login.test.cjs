const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: settle } = require('node:timers/promises');
const config = require('../owner-login/owner-live-config');
const store = require('../owner-login/fixture-store');
const ownerSession = require('../owner-login/owner-session');
const welcome = '../owner-login/pages/welcome/index';
const termsPage = '../owner-login/pages/terms/index';

test('unified entry renders after session restoration and keeps first bind and dual entry distinct', async (t) => {
  const old = { wx: global.wx, Page: global.Page, getApp: global.getApp };
  const oldConf = { ...config };
  t.after(() => {
    store.end();
    Object.assign(global, old);
    Object.assign(config, oldConf);
    delete require.cache[require.resolve(welcome)];
    delete require.cache[require.resolve(termsPage)];
  });
  Object.assign(config, {
    deployment: 'production',
    unified: true,
    origin: 'https://chmsj.cn',
    appId: 'wx1111111111111111',
    terms: { version: 'test', text: '测试协议' },
    privacy: { version: 'test', text: '测试隐私政策' },
  });
  const stored = new Map();
  const navigation = [];
  const routeCalls = [];
  let roles = [];
  let resume;
  let privacyApproved = false;
  const user = { id: 'staff-user', workspaceId: 'studio', name: '测试员工' };
  const engine = { store: { identity: user } };
  global.getApp = () => ({
    api: { resumeRemembered: () => resume, acceptWechat: async () => user },
    engine,
  });
  let definition;
  global.Page = (page) => {
    definition = page;
  };
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { appId: config.appId, envVersion: 'trial' } }),
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    openPrivacyContract() {},
    requirePrivacyAuthorize(options) {
      if (privacyApproved) options.success({});
      else options.fail({ errMsg: 'privacy declined' });
    },
    navigateTo: ({ url }) => navigation.push(url),
    getStorageSync: (key) => stored.get(key),
    setStorageSync: (key, value) => stored.set(key, value),
    removeStorageSync: (key) => stored.delete(key),
    login: (options) =>
      options?.success
        ? options.success({ code: 'verified' })
        : Promise.resolve({ code: 'verified' }),
    request(options) {
      const route = options.url.split('/').slice(-1)[0];
      routeCalls.push({ route, data: options.data });
      if (route === 'discover')
        options.success({
          statusCode: 200,
          data: { roles, phoneBinding: true, ownerBinding: true },
        });
      else if (route === 'login')
        options.success({
          statusCode: 200,
          data: {
            token: 'e'.repeat(64),
            owner: { id: 'resident', name: '测试业主' },
            projects: [{ id: 'home', title: '测试住宅' }],
          },
        });
      else if (route === 'enter')
        options.success({ statusCode: 200, data: { role: options.data.role } });
    },
    redirectTo(options) {
      navigation.push(options.url);
      options.success?.({});
    },
    switchTab(options) {
      navigation.push(options.url);
      options.success?.({});
    },
  };
  require(welcome);
  const page = (options = {}) => {
    const data = structuredClone(definition.data);
    const instance = { ...definition, data, setData: (change) => Object.assign(data, change) };
    instance.onLoad(options);
    return instance;
  };

  let ready;
  resume = new Promise((resolve) => {
    ready = resolve;
  });
  const restored = page();
  assert.equal(restored.data.ready, false);
  ready(user);
  await settle();
  assert.equal(navigation.at(-1), '/pages/workbench/index');
  assert.equal(restored.data.ready, false);
  assert.equal(routeCalls.length, 0);

  resume = null;
  let entry = page();
  await settle();
  assert.equal(entry.data.ready, true);
  entry.showPolicy({ currentTarget: { dataset: { title: '用户服务协议' } } });
  assert.equal(navigation.at(-1), '/owner-login/pages/terms/index');
  entry.showPolicy({ currentTarget: { dataset: { title: '隐私政策' } } });
  assert.equal(navigation.at(-1), '/owner-login/pages/terms/index?type=privacy');
  await entry.quickLogin();
  await entry.openEmployee();
  assert.equal(routeCalls.length, 0);
  entry.toggleAgreement();
  await entry.quickLogin();
  assert.equal(routeCalls.length, 0);
  privacyApproved = true;
  await entry.quickLogin();
  assert.equal(entry.data.binding, 'employee');
  assert.equal(entry.data.roles.length, 0);
  const attempted = routeCalls.length;
  entry.setData({ password: 'temporary' });
  entry.closeBinding();
  assert.equal(entry.data.binding, '');
  assert.equal(entry.data.password, '');
  assert.equal(routeCalls.length, attempted);
  assert.equal(entry.data.ready, true);

  roles = ['owner', 'employee'];
  entry = page();
  await settle();
  entry.toggleAgreement();
  await entry.quickLogin();
  assert.equal(entry.data.binding, '');
  assert.deepEqual(entry.data.roles, roles);
  await entry.pickRole({ currentTarget: { dataset: { role: 'employee' } } });
  assert.equal(navigation.at(-1), '/pages/workbench/index');
  assert.ok(!routeCalls.some(({ data }) => data?.phoneCode));

  roles = [];
  const invite = 'a'.repeat(64);
  entry = page({ invite });
  await settle();
  entry.toggleAgreement();
  await entry.quickLogin();
  assert.equal(entry.data.binding, 'owner');
  assert.equal(entry.data.inviteDraft, invite);
  await entry.bindPhone({ detail: { code: 'provider-phone-code' } });
  assert.equal(routeCalls.at(-1).data.invite, invite);
  assert.equal(navigation.at(-1), '/owner-login/pages/home/index');
  assert.equal(ownerSession.unified(), true);

  require(termsPage);
  const policy = { ...definition, data: {}, setData: (values) => Object.assign(policy.data, values) };
  const before = routeCalls.length;
  policy.onLoad({});
  assert.equal(policy.data.title, '用户服务协议');
  assert.equal(policy.data.text, '测试协议');
  policy.onLoad({ type: 'privacy' });
  assert.equal(policy.data.title, '隐私政策');
  assert.equal(policy.data.text, '测试隐私政策');
  assert.equal(routeCalls.length, before);
});
