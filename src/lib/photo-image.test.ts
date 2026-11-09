import { expect, it } from 'vitest';
import { imageBlob } from './photo-image';
it('reconstructs persisted byte arrays with correct MIME and exact data', async () => {
  const a = new Uint8Array([255, 216, 255, 217]);
  const b = await imageBlob(a.buffer, 'image/jpeg');
  expect(b.type).toBe('image/jpeg');
  expect(new Uint8Array(await b.arrayBuffer())).toEqual(a);
});
it('legacy Blob remains readable and unknown old data is not silently discarded', async () => {
  const a = new Blob(['old photo'], { type: 'image/jpeg' });
  expect(await (await imageBlob(a)).text()).toBe('old photo');
  await expect(imageBlob({ corrupted: true })).rejects.toThrow('请保留网站数据');
});
