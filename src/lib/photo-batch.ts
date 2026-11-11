import { openDB } from 'idb';
import { verifiedOwner, type Owner } from './record-outbox';
import type { PhotoMeta } from './site-photo';
export type BatchPhoto = {
  owner: Owner;
  meta: PhotoMeta;
  original?: ArrayBuffer;
  output?: ArrayBuffer;
  mime?: string;
  error?: string;
};
const db = () =>
  openDB('chunmo-photo-batches', 1, {
    upgrade(d) {
      d.createObjectStore('photos');
    },
  });
const key = (o: Owner, id: string) => JSON.stringify([o.workspaceId, o.id, id]);
function authorize(o: Owner) {
  const a = verifiedOwner();
  if (a?.id !== o.id || a.workspaceId !== o.workspaceId)
    throw Error('账号已切换，照片仍保留在原账号');
}
export async function batchPhotos(owner: Owner): Promise<BatchPhoto[]> {
  authorize(owner);
  const d = await db();
  try {
    const rows = await d.getAll('photos');
    authorize(owner);
    return rows
      .filter(
        (r: BatchPhoto) => r.owner.id === owner.id && r.owner.workspaceId === owner.workspaceId,
      )
      .sort((a, b) => a.meta.capturedAt.localeCompare(b.meta.capturedAt));
  } finally {
    d.close();
  }
}
export async function putBatch(photo: BatchPhoto) {
  authorize(photo.owner);
  const d = await db();
  try {
    authorize(photo.owner);
    await d.put('photos', photo, key(photo.owner, photo.meta.requestId));
  } finally {
    d.close();
  }
}
/** Called only after the user explicitly confirms the shared photos are visible in Photos. */
export async function confirmBatch(owner: Owner, ids: string[]) {
  authorize(owner);
  const d = await db();
  try {
    authorize(owner);
    const tx = d.transaction('photos', 'readwrite');
    for (const id of ids) {
      const k = key(owner, id),
        row = await tx.store.get(k);
      if (row?.output) await tx.store.delete(k);
    }
    await tx.done;
  } finally {
    d.close();
  }
}
