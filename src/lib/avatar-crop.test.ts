import { describe, it, expect } from 'vitest';
import { cropGeometry, maxCropZoom, AVATAR_MIN_SIDE } from './avatar-crop';
describe('actual-pixel photo crop', () => {
  it('never rounds the permitted zoom limit below the real-pixel minimum', () => {
    for (let w = 720; w < 2048; w += 7) {
      const aspect = 1.43;
      expect(cropGeometry(w, 1080, aspect, maxCropZoom(w, 1080, aspect), 0.5, 0.5).width).toBe(720);
    }
  });
  it('uses the display aspect without padding, stretching or creating pixels', () => {
    for (const [w, h] of [
      [1080, 1920],
      [1920, 1080],
      [720, 1280],
      [1600, 1000],
    ]) {
      const crop = cropGeometry(w, h, 1.43, 1, 0.5, 0.5);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(w);
      expect(crop.y + crop.height).toBeLessThanOrEqual(h);
      expect(Math.abs(crop.width / crop.height - 1.43)).toBeLessThan(0.004);
      expect(crop.width).toBeGreaterThanOrEqual(AVATAR_MIN_SIDE);
    }
  });
  it('constrains zoom to real source pixels and clamps drag to the image edges', () => {
    const zoom = maxCropZoom(1080, 1920, 1.43),
      c = cropGeometry(1080, 1920, 1.43, zoom, -100, 100);
    expect(c.width).toBe(720);
    expect(c.x).toBe(0);
    expect(c.y + c.height).toBe(1920);
    expect(cropGeometry(720, 720, 1, 1, 0.5, 0.5)).toEqual({ x: 0, y: 0, width: 720, height: 720 });
  });
});
