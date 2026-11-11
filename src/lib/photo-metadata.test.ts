import { expect, it } from 'vitest';
import { photoMetadata } from './photo-metadata';
import { watermarkLayout, watermarkSvg, type PhotoMeta } from './site-photo';
it('exports true GPS and manual provenance without altering pixel bytes or exposing receipt tokens', async () => {
  const m = {
    placeName: '手动地点',
    placeSource: 'user-manual',
    nearby: false,
    placeToken: 'private-receipt',
    location: { latitude: 30, longitude: 120, accuracy: 12, obtainedAt: new Date().toISOString() },
    actorName: '测试人员',
    capturedAt: new Date().toISOString(),
  } as PhotoMeta;
  const bytes = new Uint8Array([255, 216, 255, 217]),
    result = new Uint8Array(await (await photoMetadata(new Blob([bytes]), m)).arrayBuffer());
  expect(result.slice(0, 4)).toEqual(new Uint8Array([255, 216, 255, 225]));
  expect(result.slice(-2)).toEqual(bytes.slice(-2));
  const text = new TextDecoder().decode(result);
  expect(text).toContain('user-manual');
  expect(text).toContain('accuracy');
  expect(text).not.toContain('private-receipt');
  expect(watermarkLayout(1200, 800, m).wrapped[0]).toBe('工地定位：手动地点');
});

it('watermark uses a circular original logo, larger brand type and lighter translucent panel', () => {
  const m = {
    capturedAt: new Date().toISOString(),
    placeName: '测试地点',
    actorName: '测试',
  } as PhotoMeta;
  const l = watermarkLayout(1100, 800, m),
    svg = watermarkSvg(1100, 800, m, 'original-logo');
  expect(l.brandFont).toBeGreaterThan(l.font);
  expect(l.logoSize).toBeGreaterThan(l.brandFont);
  expect(svg).toContain('clip-path="url(#brand-circle)"');
  expect(svg).toContain('fill-opacity="0.55"');
  expect(svg).toContain('original-logo');
});
