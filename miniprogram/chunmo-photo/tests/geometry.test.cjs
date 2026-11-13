const { test } = require('node:test');
const assert = require('node:assert/strict');
const { viewport } = require('../lib/photo-geometry');
const { layout } = require('../lib/watermark');
test('portrait and landscape 16:9 viewfinder stays clear of controls and contains watermark', () => {
  for (const [w, h] of [
    [375, 667],
    [390, 844],
    [430, 932],
    [844, 390],
  ]) {
    const f = viewport(w, h, 60);
    assert.ok(Math.abs(f.width / f.height - (w > h ? 16 / 9 : 9 / 16)) < 0.001);
    assert.ok(f.left >= 0 && f.top >= 60 && f.top + f.height <= h);
    const l = layout(f.width, f.height, {
      place: { placeName: '测试工地' },
      capturedAt: new Date().toISOString(),
      actorName: '测试人员',
    });
    assert.ok(l.y >= 0 && l.y + l.boxH <= f.height);
    assert.ok(l.logoSize > l.font * 2 && l.brandFont > l.font);
  }
});
