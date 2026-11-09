import { expect, it } from 'vitest';
import { encodedDimensions } from './photo-dimensions';
it('reads PNG allocation bounds before decoding and leaves unknown bytes alone', () => {
  const b = new Uint8Array(32),
    v = new DataView(b.buffer);
  v.setUint32(0, 0x89504e47);
  v.setUint32(16, 20000);
  v.setUint32(20, 12000);
  expect(encodedDimensions(b)).toEqual({ width: 20000, height: 12000 });
  expect(encodedDimensions(new Uint8Array([0]))).toBeNull();
});
it('reads JPEG SOF after metadata segments', () => {
  const b = new Uint8Array([
    255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 11, 184, 15, 160, 3,
  ]);
  expect(encodedDimensions(b)).toEqual({ width: 4000, height: 3000 });
});
