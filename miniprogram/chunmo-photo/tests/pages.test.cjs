const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { adapter } = require('./fs.cjs');
const { PhotoStore } = require('../lib/store');
const { PhotoQueue } = require('../lib/queue');
test('actual camera page controller handles 20 synthetic takePhoto callbacks with one CameraContext', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chunmo-mini-page-'));
  const previous = { wx: global.wx, Page: global.Page, getApp: global.getApp };
  t.after(async () => {
    Object.assign(global, previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = root + '/fixture';
  await fs.writeFile(file, 'synthetic camera callback; not a real phone');
  const identity = { id: 'test-actor', workspaceId: 'test-workspace', name: '测试监理' };
  const store = new PhotoStore(adapter(), root, identity);
  await store.init();
  const engine = new PhotoQueue(store, async () => {});
  engine.autoSave = true;
  const app = {
    api: { identity },
    store,
    engine,
    captureIds: [],
    place: {
      token: 'synthetic-only',
      placeName: '测试地点',
      placeSource: 'amap-poi-selected',
      poi: { id: 'test' },
      location: { accuracy: 10, obtainedAt: new Date().toISOString() },
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    },
  };
  let page,
    contextCount = 0,
    captures = 0,
    mountedUpdates = 0;
  global.getApp = () => app;
  global.Page = (value) => {
    page = value;
  };
  global.wx = {
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 54 }),
    createCameraContext() {
      contextCount++;
      return {
        takePhoto(o) {
          assert.equal(o.quality, 'original');
          captures++;
          o.success({ tempImagePath: file });
        },
      };
    },
    vibrateShort() {},
  };
  const modulePath = require.resolve('../pages/camera/index');
  delete require.cache[modulePath];
  require(modulePath);
  page.data = structuredClone(page.data);
  page.setData = (patch) => {
    if ('mounted' in patch) mountedUpdates++;
    Object.assign(page.data, patch);
  };
  page.selectComponent = () => ({
    render: async () => ({ path: file, width: 4000, height: 3000 }),
  });
  page.onLoad();
  page.onReady();
  page.cameraReady();
  for (let i = 0; i < 20; i++) {
    await page.capture();
    await engine.kick();
  }
  assert.equal(captures, 20);
  assert.equal(contextCount, 1);
  assert.equal(mountedUpdates, 0);
  assert.equal(page.data.captured, 20);
  assert.equal(page.data.saved, 20);
  assert.equal(store.list().length, 20);
  assert.ok(
    store
      .list()
      .every((t) => t.actorName === identity.name && t.place.placeName === app.place.placeName),
  );
  page.onUnload();
});
