const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../owner-login/fixture-store');
const { cropBox } = require('../owner-login/avatar');
const { level, plan } = require('../owner-login/purchase-reminders');

function preview(t) {
  const saved = { Page: global.Page, wx: global.wx, getApp: global.getApp };
  let definition;
  const navigation = [];
  const modulePaths = [];
  global.Page = (value) => (definition = value);
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    navigateTo: ({ url }) => navigation.push(url),
    navigateBack() {},
    stopPullDownRefresh() {},
    reLaunch() {},
    showToast() {},
    request: () => assert.fail('Unexpected network request from preview'),
    uploadFile: () => assert.fail('Avatar demo must remain on device'),
  };
  t.after(() => {
    store.end();
    Object.assign(global, saved);
    for (const file of modulePaths) delete require.cache[file];
  });
  return {
    navigation,
    load(name, options) {
      const file = require.resolve(`../owner-login/pages/${name}/index.js`);
      modulePaths.push(file);
      delete require.cache[file];
      require(file);
      const page = { ...definition, data: structuredClone(definition.data) };
      page.setData = (values, done) => {
        Object.assign(page.data, values);
        done?.();
      };
      page.onLoad(options);
      page.onShow?.();
      return page;
    },
  };
}

const fixtureDate = Date.parse('2026-11-21T00:00:00+08:00');

test('owner home counts, overdue filter and residence switching follow the active project', (t) => {
  const { load, navigation } = preview(t);
  store.begin('review', fixtureDate);
  const home = load('home');
  assert.deepEqual(
    [home.data.pendingCount, home.data.totalCount, home.data.overdueCount, home.data.boughtCount],
    [3, 5, 1, 1],
  );
  home.overdue();
  assert.match(navigation.pop(), /overdue=1$/);
  const list = load('purchases', { overdue: '1' });
  assert.deepEqual(
    list.data.rows.map((row) => row.id),
    ['lighting'],
  );
  home.bought();
  assert.match(navigation.pop(), /state=bought$/);
  assert.deepEqual(
    load('purchases', { state: 'bought' }).data.rows.map((row) => row.id),
    ['sink'],
  );
  const arrived = load('purchases', { state: 'complete' });
  assert.deepEqual(
    arrived.data.statuses.map(({ label }) => label),
    ['待采购', '已下单', '已到货'],
  );
  assert.deepEqual(
    arrived.data.rows.map(({ id, statusLabel }) => [id, statusLabel]),
    [['floor', '已到货']],
  );
  home.switchResidence();
  assert.match(navigation.pop(), /profile\/index\?switch=1$/);
  const profile = load('profile', { switch: '1' });
  assert.equal(profile.data.switchOpen, true);

  const { project, groups } = store.snapshot();
  assert.throws(
    () => store.update('lighting', project.id, groups.pending[0].version, store.blankFeedback),
    /请填写品牌和型号/,
  );
  store.update('lighting', project.id, groups.pending[0].version, {
    brand: '测试品牌',
    model: 'J-1',
    note: '',
  });
  home.onShow();
  list.onShow();
  assert.deepEqual(
    [home.data.pendingCount, home.data.totalCount, home.data.overdueCount, home.data.boughtCount],
    [2, 5, 0, 2],
  );
  assert.deepEqual(list.data.rows, []);
  const purchased = store.snapshot().groups.bought.find(({ id }) => id === 'lighting');
  store.revoke(purchased.id, project.id, purchased.version);
  home.onShow();
  assert.equal(home.data.overdueCount, 1);
  profile.chooseProject({ currentTarget: { dataset: { id: 'demo-b' } } });
  home.onShow();
  assert.deepEqual(
    [home.data.pendingCount, home.data.totalCount, home.data.overdueCount],
    [1, 1, 0],
  );

  store.begin('single', fixtureDate);
  home.onShow();
  const single = load('profile', { switch: '1' });
  assert.equal(home.data.canSwitch, false);
  assert.equal(single.data.projects.length, 1);
  single.toggleProjects();
  assert.equal(single.data.switchOpen, false);
  home.switchResidence();
  assert.equal(navigation.length, 0);
  const offline = (store.begin('offline', fixtureDate), load('profile'));
  assert.ok(offline.data.error);
  assert.equal(offline.data.owner.name, '演示业主');
});

test('owner home lists all pending purchases from earliest deadline and hides other states', async (t) => {
  const { load } = preview(t);
  const api = require('../owner-login/owner-session');
  const { session, purchases } = api;
  t.after(() => Object.assign(api, { session, purchases }));
  const auth = {
    owner: { id: 'owner', name: '测试业主' },
    projects: [{ id: 'a', title: '测试住宅' }],
    purchasesEnabled: true,
  };
  const records = [
    ['later-d', '2026-12-18', 'pending'],
    ['old-bought', '2026-11-17', 'bought'],
    ['same-b', '2026-11-28', 'pending'],
    ['later-e', '2026-12-20', 'pending'],
    ['first', '2026-11-18', 'pending'],
    ['same-a', '2026-11-28', 'pending'],
    ['old-complete', '2026-11-19', 'complete'],
  ].map(([id, due, state]) => ({ id, title: id, due, state }));
  api.session = async () => auth;
  api.purchases = async () => ({ items: [...records] });
  store.beginVerified(auth);
  const home = load('home');
  await home.onShow();
  assert.equal(home.data.pendingCount, 5);
  assert.deepEqual(
    home.data.recent.map(({ id }) => id),
    ['first', 'same-a', 'same-b', 'later-d', 'later-e'],
  );
  records.push(
    { id: 'added-earlier', title: '新发布采购一', due: '2026-11-20', state: 'pending' },
    { id: 'added-later', title: '新发布采购二', due: '2027-01-05', state: 'pending' },
  );
  await home.onPullDownRefresh();
  assert.equal(home.data.pendingCount, 7);
  assert.equal(home.data.totalCount, 9);
  const expected = [
    'first',
    'added-earlier',
    'same-a',
    'same-b',
    'later-d',
    'later-e',
    'added-later',
  ];
  assert.deepEqual(
    home.data.recent.map(({ id }) => id),
    expected,
  );
  const list = load('purchases', { state: 'pending' });
  await list.onShow();
  assert.deepEqual(
    list.data.rows.map(({ id }) => id),
    expected,
  );
});

test('avatar chooses from album, renders and exports a square, preserving previous avatar on cancel or failure', async (t) => {
  const { load } = preview(t);
  store.begin('review', fixtureDate);
  const draws = [];
  const ctx = { fillRect() {}, drawImage: (...args) => draws.push(args) };
  const canvas = {
    createImage() {
      return {
        width: 1800,
        height: 1200,
        set src(_path) {
          this.onload();
        },
      };
    },
    getContext: () => ctx,
  };
  const selector = {
    select: () => selector,
    fields: () => selector,
    exec: (receive) => receive([{ node: canvas, width: 200 }]),
  };
  let exportedSize = 512;
  Object.assign(global.wx, {
    chooseMedia: async (options) => {
      assert.deepEqual(options.sourceType, ['album']);
      assert.deepEqual(options.mediaType, ['image']);
      return { tempFiles: [{ tempFilePath: '/test/source.jpg' }] };
    },
    createSelectorQuery: () => selector,
    canvasToTempFilePath: async ({ canvas: source, destWidth, destHeight }) => {
      assert.equal(source, canvas);
      assert.deepEqual([destWidth, destHeight], [512, 512]);
      return { tempFilePath: '/test/square.jpg' };
    },
    getImageInfo: async () => ({ width: 512, height: exportedSize }),
  });
  const profile = load('profile');
  await profile.chooseAvatar();
  assert.equal(profile.data.cropReady, true);
  assert.deepEqual(draws.at(-1).slice(1), [300, 0, 1200, 1200, 0, 0, 512, 512]);
  profile.changeZoom({ detail: { value: 2 } });
  profile.gestureStart({ touches: [{ pageX: 100, pageY: 100 }] });
  profile.gestureMove({ touches: [{ pageX: 500, pageY: 500 }] });
  assert.deepEqual(draws.at(-1).slice(1), [0, 0, 600, 600, 0, 0, 512, 512]);
  await profile.saveAvatar();
  assert.equal(profile.data.cropOpen, false);
  assert.equal(profile.data.owner.avatar, '/test/square.jpg');
  store.choose('demo-b');
  assert.equal(store.snapshot().owner.avatar, '/test/square.jpg');
  await profile.chooseAvatar();
  exportedSize = 510;
  await profile.saveAvatar();
  assert.equal(profile.data.cropOpen, true);
  assert.equal(profile.data.savingAvatar, false);
  profile.closeCrop();
  global.wx.chooseMedia = async () => {
    throw { errMsg: 'chooseMedia:fail cancel' };
  };
  await profile.chooseAvatar();
  assert.equal(profile.data.cropOpen, false);
  assert.equal(store.snapshot().owner.avatar, '/test/square.jpg');
  profile.logOut();
  store.begin('review', fixtureDate);
  assert.equal(store.snapshot().owner.avatar, '');
  assert.deepEqual(cropBox(500, 1000), { x: 0, y: 250, size: 500, zoom: 1 });
});

test('reminders use a fifteen-day boundary and dedupe by recipient, residence, due date and priority', () => {
  const today = '2026-11-21';
  const soon = { id: 'lighting', state: 'pending', due: '2026-12-06' };
  assert.equal(level(soon, today), 'due-soon');
  assert.equal(level({ ...soon, due: '2026-12-07' }, today), null);
  assert.equal(level({ ...soon, due: today }, today), 'due-soon');
  assert.equal(level({ ...soon, state: 'complete' }, today), null);
  assert.equal(level({ ...soon, state: 'bought' }, today), null);
  const first = plan('owner-a', 'project-a', soon, today);
  assert.equal(first.channel, 'wechat-mini-subscribe');
  assert.equal(first.dedupeKey, plan('owner-a', 'project-a', soon, '2026-12-03').dedupeKey);
  assert.notEqual(first.dedupeKey, plan('owner-b', 'project-a', soon, today).dedupeKey);
  assert.notEqual(first.dedupeKey, plan('owner-a', 'project-b', soon, today).dedupeKey);
  assert.notEqual(
    first.dedupeKey,
    plan('owner-a', 'project-a', { ...soon, due: today }, today).dedupeKey,
  );
  const overdue = plan('owner-a', 'project-a', soon, '2026-12-07');
  assert.equal(overdue.priority, 'overdue');
  assert.notEqual(first.dedupeKey, overdue.dedupeKey);
});

test('UI tuning shows live edits only in development and exports one config', (t) => {
  const { load } = preview(t);
  let clipboard;
  global.wx.setClipboardData = ({ data }) => {
    clipboard = JSON.parse(data);
  };
  const change = (key, value) => ({ currentTarget: { dataset: { key } }, detail: { value } });
  store.begin();
  const welcome = load('welcome');
  assert.equal(welcome.data.ui.sloganText, '功 能 与 美  ×  共 生');
  assert.equal(welcome.data.uiDev, true);
  welcome.toggleUi();
  assert.equal(welcome.data.uiOpen, true);
  welcome.changeUi(change('logoToBrandGap', 18));
  assert.match(welcome.data.uiStyle, /--ui-logo-to-brand-gap:18px/);
  assert.equal(load('welcome').data.ui.logoToBrandGap, 18);

  const profile = load('profile');
  assert.equal(profile.data.ui.footerVisible, true);
  profile.changeUi(change('footerVisible', false));
  profile.changeUi(change('avatarSize', 64));
  profile.copyUi();
  assert.equal(clipboard.login.logoToBrandGap, 18);
  assert.equal(clipboard.profile.avatarSize, 64);
  assert.equal(clipboard.profile.footerVisible, false);
  assert.equal(clipboard.home.primaryCardHeight, 64);

  let version = 'trial';
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: version } });
  const trial = load('profile');
  assert.equal(trial.data.uiDev, false);
  assert.equal(trial.data.ui.footerVisible, true);
  trial.changeUi(change('avatarSize', 70));
  assert.equal(trial.data.ui.avatarSize, 63);
  version = 'release';
  const release = load('profile');
  assert.equal(release.data.ready, false);
  assert.equal(release.data.uiDev, false);
  version = 'develop';
  profile.resetUi();
  welcome.resetUi();
  assert.equal(profile.data.ui.footerVisible, true);
  assert.equal(welcome.data.ui.logoToBrandGap, 19);
});
