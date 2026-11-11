import 'fake-indexeddb/auto';
import { expect, it, beforeEach, vi } from 'vitest';
import { batchPhotos, putBatch, confirmBatch, type BatchPhoto } from './photo-batch';
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
  await confirmBatch(
    owner,
    rows.map((r) => r.meta.requestId),
  );
});
it('retains originals on failure; replaces them only after output is durably written, and confirms exact IDs', async () => {
  await putBatch(row('one'));
  await putBatch(row('two', new Uint8Array([2]).buffer));
  expect(
    (await batchPhotos(owner)).find((r) => r.meta.requestId === 'one')?.original,
  ).toBeDefined();
  await confirmBatch(owner, ['one']);
  expect((await batchPhotos(owner)).some((r) => r.meta.requestId === 'one')).toBe(true);
  await putBatch(row('one', new Uint8Array([3]).buffer));
  expect(
    (await batchPhotos(owner)).find((r) => r.meta.requestId === 'one')?.original,
  ).toBeUndefined();
  await confirmBatch(owner, ['one']);
  expect((await batchPhotos(owner)).map((r) => r.meta.requestId)).toEqual(['two']);
});
it('rejects another account and keeps recovery data', async () => {
  await expect(batchPhotos({ id: 'b', workspaceId: 'w' })).rejects.toThrow('账号');
});
