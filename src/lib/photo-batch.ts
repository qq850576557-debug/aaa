import { openDB } from 'idb';
import { verifiedOwner, type Owner } from './record-outbox';
import type { PhotoMeta } from './site-photo';
export type BatchPhoto = {
  owner: Owner;
  meta: PhotoMeta;
  original?: ArrayBuffer;
  output?: ArrayBuffer;
  thumbnail?: Blob;
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
/** UI must obtain explicit deletion confirmation; sharing/downloading never calls this. */
export async function deleteBatch(owner: Owner, ids: string[]) {
  authorize(owner);
  const d = await db();
  try {
    authorize(owner);
    const tx = d.transaction('photos', 'readwrite');
    for (const id of ids) {
      await tx.store.delete(key(owner, id));
    }
    await tx.done;
  } finally {
    d.close();
  }
}

export type BatchSummary = Omit<BatchPhoto, 'original' | 'output' | 'thumbnail'> & {
  hasOriginal: boolean;
  hasOutput: boolean;
  outputSize: number;
};
export function summarizeBatch(row: BatchPhoto): BatchSummary {
  const { original, output, thumbnail: _thumbnail, ...rest } = row;
  return {
    ...rest,
    hasOriginal: !!original,
    hasOutput: !!output,
    outputSize: output?.byteLength || 0,
  };
}
/** Patch only the derived preview; never rewrite a stale original/output record during recovery. */
export async function cacheBatchThumbnail(owner: Owner, id: string, thumbnail: Blob) {
  authorize(owner);
  const d = await db();
  try {
    authorize(owner);
    const tx = d.transaction('photos', 'readwrite'),
      k = key(owner, id),
      row = await tx.store.get(k);
    if (row?.output && !row.thumbnail) await tx.store.put({ ...row, thumbnail }, k);
    await tx.done;
  } finally {
    d.close();
  }
}
export async function getBatch(owner: Owner, id: string): Promise<BatchPhoto | undefined> {
  authorize(owner);
  const d = await db();
  try {
    const row = await d.get('photos', key(owner, id));
    authorize(owner);
    return row;
  } finally {
    d.close();
  }
}
/** Visit one image at a time; never retain all image buffers when restoring a large batch. */
export async function batchSummaries(owner: Owner): Promise<BatchSummary[]> {
  authorize(owner);
  const d = await db();
  try {
    const rows: BatchSummary[] = [];
    const prefix = JSON.stringify([owner.workspaceId, owner.id]).slice(0, -1) + ',';
    let cursor = await d
      .transaction('photos')
      .store.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    while (cursor) {
      const row = cursor.value as BatchPhoto;
      if (row.owner.id === owner.id && row.owner.workspaceId === owner.workspaceId)
        rows.push(summarizeBatch(row));
      cursor = await cursor.continue();
    }
    authorize(owner);
    return rows.sort((a, b) => a.meta.capturedAt.localeCompare(b.meta.capturedAt));
  } finally {
    d.close();
  }
}
