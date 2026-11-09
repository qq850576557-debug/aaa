import { describe, expect, it } from 'vitest';
import { photoInput, photoTime, watermarkSvg } from './site-photo';
import { exifCapture } from './photo-exif';
describe('site photo boundaries', () => {
  it('Shanghai time is independent of host timezone', () =>
    expect(photoTime('2026-11-09T06:36:00.000Z')).toBe('2026.11.09 14:36'));
  it('watermark escapes names and embeds only supplied original logo without inventing location', () => {
    const svg = watermarkSvg(
      4000,
      3000,
      {
        requestId: crypto.randomUUID(),
        projectId: 'p',
        projectName: '<工地&>',
        actorId: 'a',
        actorName: '王师傅',
        originalName: 'photo.jpg',
        originalSize: 1,
        capturedAt: '2026-11-09T06:36:00.000Z',
        captureSource: 'file-selection',
        location: null,
        outputWidth: 4000,
        outputHeight: 3000,
      },
      'data:image/jpeg;base64,abcd',
    );
    expect(svg).toContain('&lt;工地&amp;&gt;');
    expect(svg).toContain('定位：未获取');
    expect(svg).toContain('选图时间');
    expect(svg).toContain('data:image/jpeg;base64,abcd');
    expect(svg).not.toContain('GPS精度');
  });
  it('refuses client actor injection', () =>
    expect(() =>
      photoInput.parse({ requestId: crypto.randomUUID(), actorId: 'another' }),
    ).toThrow());
  it('invalid image has no fabricated EXIF', () =>
    expect(exifCapture(new Uint8Array([1, 2, 3]))).toBeNull());
  it('reads original EXIF time and timezone without modifying bytes', () => {
    const b = new Uint8Array(128);
    const v = new DataView(b.buffer);
    b.set([255, 216, 255, 225]);
    v.setUint16(4, 124);
    b.set([...Buffer.from('Exif\0\0')], 6);
    const base = 12;
    v.setUint16(base, 0x4949);
    v.setUint16(base + 2, 42, true);
    v.setUint32(base + 4, 8, true);
    v.setUint16(base + 8, 1, true);
    v.setUint16(base + 10, 0x8769, true);
    v.setUint32(base + 18, 26, true);
    v.setUint16(base + 26, 1, true);
    v.setUint16(base + 28, 0x9003, true);
    v.setUint16(base + 30, 2, true);
    v.setUint32(base + 32, 20, true);
    v.setUint32(base + 36, 50, true);
    b.set(Buffer.from('2026:11:09 14:36:00\0'), base + 50);
    const before = b.slice();
    expect(exifCapture(b)?.at).toBe('2026-11-09T06:36:00.000Z');
    expect(b).toEqual(before);
  });
});
