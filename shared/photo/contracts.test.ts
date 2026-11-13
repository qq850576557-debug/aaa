import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';
import { watermarkLayout, photoTime } from '../../src/lib/photo-layout';
import { freshPlace } from '../../src/lib/photo-location';
import type { PhotoMeta } from '../../src/lib/site-photo';

const path = 'shared/photo/legacy-protocol.ts';
const compiled = await transform(await readFile(path, 'utf8'), {
  loader: 'ts',
  format: 'esm',
  target: 'es2022',
});
const native = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64')
);
test('native sources use byte-identical original logo and keep production/PWA sources independent', async () => {
  const paths = [
    'public/brand/source/chunmo-original.jpg',
    'miniprogram/chunmo-photo/assets/chunmo-original.jpg',
  ];
  const hashes = await Promise.all(
    paths.map(async (p) =>
      createHash('sha256')
        .update(await readFile(p))
        .digest('hex'),
    ),
  );
  assert.equal(new Set(hashes).size, 1);
  const spec = JSON.parse(await readFile('shared/photo/protocol-v1.json', 'utf8'));
  assert.equal(hashes[0], spec.brandSha256);
});
test('actual ArkTS pure protocol matches production GPS expiry and rejects manual places', () => {
  const now = new Date().toISOString(),
    p = {
      token: 'synthetic',
      location: { latitude: 30, longitude: 120, accuracy: 12, obtainedAt: now },
      placeName: '测试工地',
      placeSource: 'amap-poi-selected',
      nearby: true,
      poi: { id: 'test', latitude: 30, longitude: 120 },
      resolvedAt: now,
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    };
  assert.equal(native.fresh(p), freshPlace(p));
  assert.equal(native.fresh({ ...p, placeSource: 'manual' }), false);
  assert.equal(native.fresh({ ...p, expiresAt: '2000-01-01T00:00:00.000Z' }), false);
  assert.equal(native.fresh({ ...p, location: { ...p.location, accuracy: 101 } }), false);
});
test('actual ArkTS geometry, wrapping and Shanghai date equal the current V3.2 watermark contract', () => {
  for (const [w, h] of [
    [4000, 3000],
    [3000, 4000],
    [3840, 2160],
    [800, 600],
  ])
    for (const at of ['2026-11-11T23:59:42Z', '2026-01-01T00:00:00Z']) {
      const m = {
        placeName: '测试现场名称'.repeat(8),
        capturedAt: at,
        actorName: '测试监理',
      } as PhotoMeta;
      const a = watermarkLayout(w, h, m),
        b = native.nativeMark(w, h, m.placeName, at, m.actorName);
      for (const key of Object.keys(a)) {
        const expected = a[key as keyof typeof a],
          actual = b[key];
        if (typeof expected === 'number') assert.ok(Math.abs(expected - actual) < 1e-8, key);
        else assert.deepEqual(actual, expected, key);
      }
      assert.equal(native.shanghai(at), photoTime(at));
    }
});
