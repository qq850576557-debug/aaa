import 'fake-indexeddb/auto';
import { expect, it, beforeEach, vi } from 'vitest';
import {
  batchPhotos,
  putBatch,
  deleteBatch,
  type BatchPhoto,
  batchSummaries,
  getBatch,
  cacheBatchThumbnail,
} from './photo-batch';
vi.mock('./record-outbox', () => ({ verifiedOwner: () => ({ id: 'a', workspaceId: 'w' }) }));
const owner = { id: 'a', workspaceId: 'w' };
const row = (id: string, output?: ArrayBuffer): BatchPhoto => ({
  owner,
  meta: {
    requestId: id,
    projectId: '',
    projectName: '',
    actorId: 'a',
    actorName: 'A',
    capturedAt: new Date().toISOString(),
    captureSource: 'live-camera',
    originalName: 'a.jpg',
    originalSize: 1,
    outputWidth: 1,
    outputHeight: 1,
    location: null,
  },
  original: output ? undefined : new Uint8Array([1]).buffer,
  output,
});
beforeEach(async () => {
  const rows = await batchPhotos(owner);
  await deleteBatch(
    owner,
    rows.map((r) => r.meta.requestId),
  );
});
it('retains originals on failure; replaces them only after output is durably written, and explicit deletion targets exact IDs', async () => {
  await putBatch(row('one'));
  await putBatch(row('two', new Uint8Array([2]).buffer));
  expect(
    (await batchPhotos(owner)).find((r) => r.meta.requestId === 'one')?.original,
  ).toBeDefined();
  // Merely reading/recovering a capture never clears the only original.
  expect((await getBatch(owner, 'one'))?.original).toBeDefined();
  await putBatch(row('one', new Uint8Array([3]).buffer));
  expect(
    (await batchPhotos(owner)).find((r) => r.meta.requestId === 'one')?.original,
  ).toBeUndefined();
  await deleteBatch(owner, ['one']);
  expect((await batchPhotos(owner)).map((r) => r.meta.requestId)).toEqual(['two']);
});
it('rejects another account and keeps recovery data', async () => {
  await expect(batchPhotos({ id: 'b', workspaceId: 'w' })).rejects.toThrow('账号');
});

it('restores only summaries and fetches one photo under account isolation', async () => {
  await putBatch(row('summary', new Uint8Array([9, 8]).buffer));
  const summaries = await batchSummaries(owner),
    info = summaries.find((r) => r.meta.requestId === 'summary')!;
  expect(info.hasOutput).toBe(true);
  expect(info.outputSize).toBe(2);
  expect(info).not.toHaveProperty('output');
  expect(info).not.toHaveProperty('original');
  expect((await getBatch(owner, 'summary'))?.output?.byteLength).toBe(2);
  await expect(getBatch({ id: 'b', workspaceId: 'w' }, 'summary')).rejects.toThrow('账号');
});

it('caches only derived thumbnails without changing output, source metadata or account boundaries', async () => {
  const image = row('thumb', new Uint8Array([255, 216, 7]).buffer);
  await putBatch(image);
  await cacheBatchThumbnail(owner, 'thumb', new Blob(['small'], { type: 'image/jpeg' }));
  const stored = await getBatch(owner, 'thumb');
  expect(Array.from(new Uint8Array(stored!.output!))).toEqual([255, 216, 7]);
  expect(stored!.meta).toEqual(image.meta);
  expect(stored!.thumbnail?.size).toBe(5);
  expect(
    (await batchSummaries(owner)).find((r) => r.meta.requestId === 'thumb'),
  ).not.toHaveProperty('thumbnail');
  await expect(
    cacheBatchThumbnail({ id: 'b', workspaceId: 'w' }, 'thumb', new Blob(['x'])),
  ).rejects.toThrow('账号');
  await expect(deleteBatch({ id: 'b', workspaceId: 'w' }, ['thumb'])).rejects.toThrow('账号');
  await deleteBatch(owner, ['thumb']);
  await cacheBatchThumbnail(owner, 'thumb', new Blob(['x']));
  expect(await getBatch(owner, 'thumb')).toBeUndefined();
});
it('explicit deletion may remove a failed capture without affecting other photos', async () => {
  await putBatch(row('failed'));
  await putBatch(row('retained'));
  await deleteBatch(owner, ['failed']);
  expect(await getBatch(owner, 'failed')).toBeUndefined();
  expect((await getBatch(owner, 'retained'))?.original).toBeDefined();
});
