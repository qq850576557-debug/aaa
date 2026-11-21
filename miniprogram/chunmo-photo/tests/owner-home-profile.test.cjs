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
      page.onShow();
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
  home.switchResidence();
  assert.match(navigation.pop(), /profile\/index\?switch=1$/);
  const profile = load('profile', { switch: '1' });
  assert.equal(profile.data.switchOpen, true);

  const { project, groups } = store.snapshot();
  store.update('lighting', project.id, groups.pending[0].version, store.blankFeedback);
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
