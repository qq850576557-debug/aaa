import { expect, it, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { photoZip } from './photo-zip';
import { shareFailure, validPhotoFiles } from './photo-share';
afterEach(() => vi.unstubAllGlobals());
it('writes a standard Unicode ZIP with complete JPEG bytes and valid CRC', async () => {
  vi.stubGlobal('navigator', {});
  const one = new Uint8Array([255, 216, 1, 2, 3, 255, 217]).buffer,
    two = new Uint8Array([255, 216, 4, 5, 6, 255, 217]).buffer;
  const items = [
      { id: 'one', name: '春茉照片1.jpg', size: one.byteLength, at: new Date().toISOString() },
      { id: 'two', name: '春茉照片2.jpg', size: two.byteLength, at: new Date().toISOString() },
    ],
    progress: number[] = [];
  const archive = await photoZip(
    items,
    async (id) => (id === 'one' ? one : two),
    '测试.zip',
    'test',
    (n) => progress.push(n),
  );
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import sys,io,zipfile,json,base64; z=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.argv[1]))); assert z.testzip() is None; print(json.dumps({n:list(z.read(n)) for n in z.namelist()},ensure_ascii=False))',
      Buffer.from(await archive.file.arrayBuffer()).toString('base64'),
    ],
    { timeout: 10000 },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    '春茉照片1.jpg': Array.from(new Uint8Array(one)),
    '春茉照片2.jpg': Array.from(new Uint8Array(two)),
  });
  expect(progress).toEqual([1, 2]);
  expect(archive.storage).toBe('memory');
});
it('rejects oversized memory-only ZIPs before reading images and preserves source bytes on errors', async () => {
  vi.stubGlobal('navigator', {});
  const read = vi.fn();
  await expect(
    photoZip(
      [{ id: 'big', name: 'big.jpg', size: 70 * 1024 * 1024, at: new Date().toISOString() }],
      read,
      'out.zip',
      'test',
      () => {},
    ),
  ).rejects.toThrow('分批ZIP');
  expect(read).not.toHaveBeenCalled();
  const bytes = new Uint8Array([255, 216, 0]);
  await expect(
    photoZip(
      [{ id: 'bad', name: 'x.jpg', size: 5, at: new Date().toISOString() }],
      async () => bytes.buffer,
      'bad.zip',
      'test',
      () => {},
    ),
  ).rejects.toThrow('异常');
  expect(bytes).toEqual(new Uint8Array([255, 216, 0]));
});
it('distinguishes Android share failures and validates actual JPEG files', () => {
  for (const name of [
    'NotAllowedError',
    'DataError',
    'TypeError',
    'AbortError',
    'InvalidStateError',
  ]) {
    const error = new Error('test');
    error.name = name;
    expect(shareFailure(error).message).toContain(name);
    expect(shareFailure(error).message).not.toContain('成功');
  }
  expect(
    validPhotoFiles([new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' })]),
  ).toBe(true);
  expect(validPhotoFiles([new File([], 'photo.jpg', { type: 'image/jpeg' })])).toBe(false);
  expect(validPhotoFiles([new File(['x'], 'photo.jpg', { type: 'text/plain' })])).toBe(false);
});
