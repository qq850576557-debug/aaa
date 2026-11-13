const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { adapter } = require('./fs.cjs');
const { PhotoStore } = require('../lib/store');
const { PhotoQueue } = require('../lib/queue');
const { fresh, mergePlaces } = require('../lib/location');
const { layout, photoTime, neutralizeExif, orientationTransform } = require('../lib/watermark');
const actor = { id: 'test-account', workspaceId: 'test-workspace', name: '测试监理' };
function place() {
  return {
    placeName: '测试地点',
    placeSource: 'amap-poi-selected',
    token: 'fixture-only',
    poi: { id: 'p1' },
    location: { accuracy: 20, obtainedAt: new Date().toISOString() },
    expiresAt: new Date(Date.now() + 90000).toISOString(),
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chunmo-mini-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const io = adapter(),
    store = new PhotoStore(io, root, actor);
  await store.init();
  const file = path.join(root, 'synthetic.jpg');
  await fs.writeFile(file, 'explicit synthetic bytes, not a real camera image');
  const add = async () => {
    const task = await store.reserve(place(), new Date().toISOString());
    await store.persistRaw(task.id, file);
    return store.tasks.get(task.id);
  };
  return { root, io, store, file, add };
}
test('20 synthetic queue jobs saved once, durable restart preserves all photo bytes and stages', async (t) => {
  const f = await fixture(t),
    saved = [],
    rendererIds = [];
  const engine = new PhotoQueue(f.store, async (file) => saved.push(file));
  engine.autoSave = true;
  engine.renderer = async (task) => {
    rendererIds.push(task.id);
    return { path: f.file, width: 4000, height: 3000 };
  };
  for (let i = 0; i < 20; i++) {
    await f.add();
    await engine.kick();
  }
  assert.equal(engine.stats().saved, 20);
  assert.equal(new Set(saved).size, 20);
  assert.equal(rendererIds.length, 20);
  await engine.kick();
  assert.equal(saved.length, 20);
  const again = new PhotoStore(adapter(), f.root, actor);
  await again.init();
  assert.equal(again.list().length, 20);
  assert.ok(again.list().every((t) => t.stage === 'saved'));
  for (const task of again.list())
    assert.equal(await fs.readFile(task.dir + '/raw', 'utf8'), await fs.readFile(f.file, 'utf8'));
  // Different owner never sees or cleans these records.
  const other = new PhotoStore(adapter(), f.root, { ...actor, id: 'other' });
  await other.init();
  assert.equal(other.list().length, 0);
});
test('permission rejection keeps ready output; retry skips watermark and confirmed successes', async (t) => {
  const f = await fixture(t),
    task = await f.add();
  let reject = true,
    renders = 0,
    saves = 0;
  const engine = new PhotoQueue(f.store, async () => {
    saves++;
    if (reject) throw { errMsg: 'saveImageToPhotosAlbum:fail auth deny' };
  });
  engine.renderer = async () => {
    renders++;
    return { path: f.file, width: 1000, height: 2000 };
  };
  engine.autoSave = true;
  await engine.kick();
  assert.equal(f.store.tasks.get(task.id).stage, 'ready');
  assert.equal(engine.autoSave, false);
  reject = false;
  await engine.saveOnly(task.id);
  assert.equal(f.store.tasks.get(task.id).stage, 'saved');
  await engine.saveOnly(task.id);
  assert.equal(renders, 1);
  assert.equal(saves, 2);
});
test('uncertain save and crash-in-saving never automatically duplicate a photo', async (t) => {
  const f = await fixture(t),
    task = await f.add();
  let saves = 0;
  const engine = new PhotoQueue(f.store, async () => {
    saves++;
    throw Error('platform interrupted');
  });
  engine.renderer = async () => ({ path: f.file, width: 1000, height: 2000 });
  engine.autoSave = true;
  await engine.kick();
  assert.equal(f.store.tasks.get(task.id).stage, 'unknown');
  await engine.kick();
  assert.equal(saves, 1);
  await assert.rejects(engine.retry(task.id), /核对相册/);
  await f.store.update(task.id, { stage: 'saving' });
  const again = new PhotoStore(adapter(), f.root, actor);
  await again.init();
  assert.equal(again.tasks.get(task.id).stage, 'unknown');
});
test('OS success followed by journal failure cannot trigger another media save', async (t) => {
  const f = await fixture(t);
  const task = await f.add();
  let count = 0;
  const engine = new PhotoQueue(f.store, async () => {
    count++;
    f.io.fail = (key, args) => key === 'writeFile' && args.data.includes('"stage":"saved"');
  });
  engine.renderer = async () => ({ path: f.file, width: 4000, height: 3000 });
  engine.autoSave = true;
  await engine.kick();
  await engine.kick();
  assert.equal(count, 1);
  assert.ok(engine.uncertain.has(task.id));
  const recovered = new PhotoStore(adapter(), f.root, actor);
  await recovered.init();
  assert.equal(recovered.tasks.get(task.id).stage, 'unknown');
});
test('disk-full capture retains previous good journal and supports same-ID persistence retry', async (t) => {
  const f = await fixture(t),
    task = await f.store.reserve(place(), new Date().toISOString());
  f.io.fail = (key) => key === 'copyFile';
  await assert.rejects(f.store.persistRaw(task.id, f.file));
  assert.equal(f.store.tasks.get(task.id).stage, 'capturing');
  assert.equal(
    await fs.readFile(f.file, 'utf8'),
    'explicit synthetic bytes, not a real camera image',
  );
  f.io.fail = null;
  await f.store.persistRaw(task.id, f.file);
  assert.equal(f.store.tasks.get(task.id).stage, 'raw');
  assert.equal(f.store.list().length, 1);
});
test('raw rename before metadata interruption is recovered; corrupt latest revision falls back', async (t) => {
  const f = await fixture(t),
    task = await f.store.reserve(place(), new Date().toISOString());
  f.io.fail = (key, o) => key === 'writeFile' && o.data.includes('"stage":"raw"');
  await assert.rejects(f.store.persistRaw(task.id, f.file));
  f.io.fail = null;
  const again = new PhotoStore(adapter(), f.root, actor);
  await again.init();
  assert.equal(again.tasks.get(task.id).stage, 'raw');
  await fs.writeFile(task.dir + '/r-99999999.json', '{broken');
  const third = new PhotoStore(adapter(), f.root, actor);
  await third.init();
  assert.equal(third.tasks.get(task.id).stage, 'unknown');
});
test('single selection saves exactly the chosen record and explicit deletion preserves others', async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    b = await f.add(),
    saved = [];
  const engine = new PhotoQueue(f.store, async (file) => saved.push(file));
  engine.renderer = async () => ({ path: f.file, width: 4000, height: 3000 });
  await engine.kick();
  await engine.saveOnly(b.id);
  assert.deepEqual(saved, [b.dir + '/marked.jpg']);
  await f.store.remove(b.id);
  assert.equal(f.store.tasks.get(b.id).deleted, true);
  assert.ok(await f.store.exists(a.dir + '/raw'));
  assert.ok(await f.store.exists(a.dir + '/marked.jpg'));
});
test('render failure preserves original and retries once without altering capture identity/time', async (t) => {
  const f = await fixture(t),
    task = await f.add();
  let reject = true;
  const engine = new PhotoQueue(f.store, async () => {});
  engine.renderer = async () => {
    if (reject) throw Error('canvas memory');
    return { path: f.file, width: 4000, height: 3000 };
  };
  await engine.kick();
  assert.equal(f.store.tasks.get(task.id).stage, 'failed');
  reject = false;
  await engine.retry(task.id);
  await engine.saveOnly(task.id);
  const result = f.store.tasks.get(task.id);
  assert.equal(result.stage, 'saved');
  assert.equal(result.capturedAt, task.capturedAt);
  await f.store.update(task.id, { actorName: 'spoof', id: 'spoof' });
  assert.equal(f.store.tasks.get(task.id).actorName, actor.name);
});
test('location freshness, GPS precision, manual location rejection, dedup and distance order', () => {
  const p = place();
  assert.equal(fresh(p), true);
  assert.equal(fresh({ ...p, placeSource: 'manual' }), false);
  assert.equal(fresh({ ...p, location: { ...p.location, accuracy: 101 } }), false);
  assert.equal(fresh(p, Date.now() + 95000), false);
  const items = mergePlaces(
    [],
    [
      { id: 'b', distance: 300, receipt: p },
      { id: 'a', distance: 20, receipt: p },
      { id: 'x', distance: 2001, receipt: p },
    ],
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ['a', 'b'],
  );
  assert.equal(mergePlaces(items, [items[0]]).length, 2);
});
test('Shanghai watermark typography and layout stay within both photo orientations', () => {
  assert.equal(photoTime('2026-11-12T17:02:00Z'), '2026.11.13 01:02');
  for (const [w, h] of [
    [4000, 3000],
    [3000, 4000],
    [640, 480],
  ]) {
    const l = layout(w, h, {
      place: { placeName: '长地点'.repeat(22) },
      actorName: '测试监理',
      capturedAt: '2026-11-13T02:00:00Z',
    });
    assert.ok(l.x >= 0 && l.y > 0 && l.x + l.boxW < w && l.y + l.boxH < h);
    assert.ok(l.brandFont > l.font);
    assert.ok(!l.lines.join('').includes('附近'));
  }
});
test('EXIF1-8 is neutralized in decode copy; transforms preserve original pixel area', () => {
  for (let o = 1; o <= 8; o++) {
    const b = new ArrayBuffer(40),
      v = new DataView(b);
    v.setUint16(0, 0xffd8);
    v.setUint16(2, 0xffe1);
    v.setUint16(4, 34);
    v.setUint32(6, 0x45786966);
    v.setUint16(12, 0x4949);
    v.setUint16(14, 42, true);
    v.setUint32(16, 8, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 0x0112, true);
    v.setUint16(24, 3, true);
    v.setUint32(26, 1, true);
    v.setUint16(30, o, true);
    const parsed = neutralizeExif(b);
    assert.equal(parsed.orientation, o);
    assert.equal(v.getUint16(30, true), 1);
    const [a, c, b2, d, tx, ty] = orientationTransform(o, 600, 400);
    const corners = [
      [0, 0],
      [600, 0],
      [0, 400],
      [600, 400],
    ].map(([x, y]) => [a * x + b2 * y + tx, c * x + d * y + ty]);
    const xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    assert.equal(Math.min(...xs), 0);
    assert.equal(Math.min(...ys), 0);
    assert.equal(Math.max(...xs), o >= 5 ? 400 : 600);
    assert.equal(Math.max(...ys), o >= 5 ? 600 : 400);
  }
});
