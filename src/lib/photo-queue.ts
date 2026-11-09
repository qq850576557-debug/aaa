import { imageBlob } from './photo-image';
import { openDB } from 'idb';
import { cloudApi } from './cloud';
import { verifiedOwner, type Owner } from './record-outbox';
import { PHOTO_CHUNK, type PhotoInput, type PhotoMeta } from './site-photo';
export type LocalPhoto = {
  owner: Owner;
  input: PhotoInput;
  meta: PhotoMeta;
  original: Blob;
  watermarked: Blob;
  state: 'captured' | 'pending' | 'uploaded';
  association?: { requestId: string; projectId: string; version: number };
  localSavedAt?: string;
  message?: string;
};
const db = () =>
  openDB('chunmo-site-photos', 1, {
    upgrade(d) {
      d.createObjectStore('photos');
    },
  });
const key = (o: Owner, id: string) => JSON.stringify([o.workspaceId, o.id, id]);
const live = (o: Owner) => {
  const a = verifiedOwner();
  return a?.id === o.id && a.workspaceId === o.workspaceId;
};
export async function saveLocalPhoto(p: LocalPhoto) {
  const originalBytes = await p.original.arrayBuffer(),
    watermarkedBytes = await p.watermarked.arrayBuffer();
  const d = await db();
  try {
    await d.put(
      'photos',
      {
        ...p,
        original: undefined,
        watermarked: undefined,
        originalBytes,
        watermarkedBytes,
        originalMime: p.original.type,
        watermarkedMime: p.watermarked.type,
        localSavedAt: p.localSavedAt || new Date().toISOString(),
      },
      key(p.owner, p.input.requestId),
    );
  } finally {
    d.close();
  }
  window.dispatchEvent(new Event('chunmo-photos-local'));
}
export async function localPhotos(owner: Owner) {
  const d = await db();
  try {
    return ((await d.getAll('photos')) as any[])
      .filter((p) => p.owner.id === owner.id && p.owner.workspaceId === owner.workspaceId)
      .map(
        (p) =>
          ({
            ...p,
            original: p.originalBytes
              ? new Blob([p.originalBytes], { type: p.originalMime || 'image/jpeg' })
              : p.original,
            watermarked: p.watermarkedBytes
              ? new Blob([p.watermarkedBytes], { type: p.watermarkedMime || 'image/jpeg' })
              : p.watermarked,
          }) as LocalPhoto,
      );
  } finally {
    d.close();
  }
}
async function base64(b: Blob) {
  const a = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
  return btoa(s);
}
let flight: Promise<void> | null = null;
export function syncPhotos(owner: Owner) {
  if (flight) return flight;
  flight = (async () => {
    try {
      const c = await cloudApi<{ enabled: boolean }>('/site-photos/config');
      if (!c.enabled) return;
    } catch {
      return;
    }
    for (const p of await localPhotos(owner)) {
      if (!live(owner) || !navigator.onLine) return;
      if (p.state === 'captured' || (p.state === 'uploaded' && !p.association)) continue;
      try {
        const original = await imageBlob(p.original);
        let remote = await cloudApi<PhotoMeta & { hashes: Record<string, string> }>(
          '/site-photos',
          'POST',
          p.input,
        );
        for (let i = 0; i < Math.ceil(original.size / PHOTO_CHUNK) && !remote.complete; i++) {
          if (!live(owner)) return;
          if (!remote.hashes[i])
            await cloudApi(`/site-photos/${p.input.requestId}/chunks/${i}`, 'PUT', {
              data: await base64(original.slice(i * PHOTO_CHUNK, (i + 1) * PHOTO_CHUNK)),
            });
        }
        if (!live(owner)) return;
        if (!remote.complete)
          remote = await cloudApi(`/site-photos/${p.input.requestId}/complete`, 'POST', {});
        if (!live(owner)) return;
        if (!remote.complete || !remote.uploadedAt || remote.actorId !== owner.id)
          throw Error('云端尚未确认照片');
        if (p.association) {
          remote = await cloudApi(
            `/site-photos/${p.input.requestId}/project`,
            'POST',
            p.association,
          );
          if (remote.projectId !== p.association.projectId)
            throw Error('工地关联已被其他操作修改，请核对后重试');
        }
        // Server regenerates the authoritative watermark using its authenticated identity.
        await saveLocalPhoto({
          ...p,
          meta: remote,
          association: undefined,
          state: 'uploaded',
          message: '',
        });
      } catch (e) {
        if (!live(owner)) return;
        await saveLocalPhoto({
          ...p,
          message: !navigator.onLine
            ? '离线，照片已保留在应用本地'
            : e instanceof Error
              ? e.message
              : String(e),
        });
      }
    }
  })()
    .catch(() => {
      window.dispatchEvent(new Event('chunmo-photos-storage-error'));
    })
    .finally(() => {
      flight = null;
    });
  return flight;
}
