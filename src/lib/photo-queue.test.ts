import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: { id: 'photo-owner', workspaceId: 'photo-studio' },
  send: vi.fn(),
}));
vi.mock('./cloud', () => ({ cloudApi: (...args: unknown[]) => h.send(...args) }));
vi.mock('./record-outbox', () => ({ verifiedOwner: () => h.owner }));
import {
  localPhoto,
  localPhotos,
  saveLocalPhoto,
  syncPhotos,
  updateLocalPhoto,
  type LocalPhoto,
} from './photo-queue';
beforeEach(() => {
  h.owner = { id: crypto.randomUUID(), workspaceId: 'photo-studio' };
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  h.send.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
function photo(): LocalPhoto {
  const input = {
    requestId: crypto.randomUUID(),
    projectId: 'site',
    capturedAt: new Date().toISOString(),
    captureSource: 'live-camera' as const,
    originalName: '原图.jpg',
    originalSize: 5,
    outputWidth: 4000,
    outputHeight: 3000,
    location: null,
  };
  return {
    owner: h.owner,
    input,
    meta: { ...input, actorId: h.owner.id, actorName: '师傅', projectName: '工地' },
    original: new Blob(['exact original bytes'], { type: 'image/jpeg' }),
    watermarked: new Blob(['watermark'], { type: 'image/jpeg' }),
    state: 'captured',
  };
}
it('watermark and state patches retain exact original bytes and a newer project association', async () => {
  const p = photo();
  await saveLocalPhoto(p);
  const association = { requestId: crypto.randomUUID(), projectId: 'new-site', version: 0 };
  await updateLocalPhoto(h.owner, p.input.requestId, { association });
  await updateLocalPhoto(h.owner, p.input.requestId, {
    watermarked: new Blob(['new marked bytes']),
    state: 'pending',
  });
  const saved = (await localPhoto(h.owner, p.input.requestId))!;
  expect(await saved.original.text()).toBe('exact original bytes');
  expect(await saved.watermarked.text()).toBe('new marked bytes');
  expect(saved.association).toEqual(association);
  expect(await localPhotos({ ...h.owner, id: 'other-account' })).toEqual([]);
});
it('a failed upload preserves local bytes and retries the identical receipt before marking uploaded', async () => {
  const p = { ...photo(), state: 'pending' as const };
  await saveLocalPhoto(p);
  let attempts = 0;
  const ids: string[] = [];
  h.send.mockImplementation(async (path, _method, input) => {
    if (path.endsWith('/config')) return { enabled: true };
    ids.push(input.requestId);
    if (++attempts === 1) throw Error('temporary upload failure');
    return {
      ...p.meta,
      actorId: h.owner.id,
      complete: true,
      uploadedAt: new Date().toISOString(),
      hashes: {},
    };
  });
  await syncPhotos(h.owner);
  expect((await localPhoto(h.owner, p.input.requestId))?.state).toBe('pending');
  expect(await (await localPhoto(h.owner, p.input.requestId))!.original.text()).toBe(
    'exact original bytes',
  );
  await syncPhotos(h.owner);
  expect((await localPhoto(h.owner, p.input.requestId))?.state).toBe('uploaded');
  expect(ids).toEqual([p.input.requestId, p.input.requestId]);
});
it('a new photo queued during an upload receives its own follow-up pass without blocking or duplicates', async () => {
  const a = { ...photo(), state: 'pending' as const },
    b = { ...photo(), state: 'pending' as const };
  await saveLocalPhoto(a);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const ids: string[] = [];
  h.send.mockImplementation(async (path, _method, input) => {
    if (path.endsWith('/config')) return { enabled: true };
    ids.push(input.requestId);
    if (input.requestId === a.input.requestId) await held;
    return {
      ...(input.requestId === a.input.requestId ? a : b).meta,
      actorId: h.owner.id,
      complete: true,
      uploadedAt: new Date().toISOString(),
      hashes: {},
    };
  });
  const first = syncPhotos(h.owner);
  await vi.waitFor(() => expect(ids).toHaveLength(1));
  await saveLocalPhoto(b);
  expect(syncPhotos(h.owner)).toBe(first);
  release();
  await first;
  await vi.waitFor(async () =>
    expect((await localPhoto(h.owner, b.input.requestId))?.state).toBe('uploaded'),
  );
  expect(ids).toEqual([a.input.requestId, b.input.requestId]);
});
