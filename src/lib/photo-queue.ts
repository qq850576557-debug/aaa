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
  state: 'pending' | 'uploaded';
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
  const d = await db();
  try {
    await d.put(
      'photos',
      { ...p, localSavedAt: p.localSavedAt || new Date().toISOString() },
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
    return ((await d.getAll('photos')) as LocalPhoto[]).filter(
      (p) => p.owner.id === owner.id && p.owner.workspaceId === owner.workspaceId,
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
    for (const p of await localPhotos(owner)) {
      if (!live(owner) || !navigator.onLine) return;
      if (p.state === 'uploaded') continue;
      try {
        let remote = await cloudApi<PhotoMeta & { hashes: Record<string, string> }>(
          '/site-photos',
          'POST',
          p.input,
        );
        for (let i = 0; i < Math.ceil(p.original.size / PHOTO_CHUNK) && !remote.complete; i++) {
          if (!live(owner)) return;
          if (!remote.hashes[i])
            await cloudApi(`/site-photos/${p.input.requestId}/chunks/${i}`, 'PUT', {
              data: await base64(p.original.slice(i * PHOTO_CHUNK, (i + 1) * PHOTO_CHUNK)),
            });
        }
        if (!live(owner)) return;
        if (!remote.complete)
          remote = await cloudApi(`/site-photos/${p.input.requestId}/complete`, 'POST', {});
        if (!live(owner)) return;
        if (!remote.complete || !remote.uploadedAt || remote.actorId !== owner.id)
          throw Error('云端尚未确认照片');
        // Server regenerates the authoritative watermark using its authenticated identity.
        await saveLocalPhoto({ ...p, meta: remote, state: 'uploaded', message: '' });
      } catch (e) {
        if (!live(owner)) return;
        await saveLocalPhoto({ ...p, message: String(e) });
      }
    }
  })().finally(() => {
    flight = null;
  });
  return flight;
}
