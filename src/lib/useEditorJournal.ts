import { recordValue } from './records';
import { useEffect, useRef, useState } from 'react';
import { openDB } from 'idb';
import { draftTab } from './cloud-drafts';
import { inCloud } from './cloud';
import { verifiedOwner } from './record-outbox';
const database = () =>
  openDB('chunmo-editor-inputs', 1, {
    upgrade(d) {
      d.createObjectStore('drafts');
    },
  });
export function useEditorJournal<T>(
  name: string,
  value: T,
  restore: (value: T) => void,
  dirty: boolean,
) {
  const [status, setStatus] = useState('');
  const operationId = useRef(crypto.randomUUID());
  const loading = useRef(true);
  const [ready, setReady] = useState('');
  const [recovery, setRecovery] = useState<unknown>();
  const latest = useRef(value);
  latest.current = value;
  const original = useRef(value);
  const owner = verifiedOwner();
  const key = owner ? JSON.stringify([owner.workspaceId, owner.id, name, draftTab()]) : '';
  useEffect(() => {
    if (!inCloud() || !key || value === null) return;
    loading.current = true;
    let active = true;
    original.current = latest.current;
    const initial = JSON.stringify(latest.current);
    void database()
      .then(async (d) => {
        try {
          let saved = await d.get('drafts', key);
          if (!saved && navigator.locks) {
            const locks = await navigator.locks.query();
            const held = new Set(locks.held?.map((l) => l.name));
            const tx = d.transaction('drafts');
            let cursor = await tx.store.openCursor();
            while (cursor) {
              const parts = JSON.parse(String(cursor.key));
              const own = JSON.parse(key);
              if (
                parts[0] === own[0] &&
                parts[1] === own[1] &&
                parts[2] === name &&
                !held.has('chunmo-cloud-draft:' + parts[3])
              ) {
                saved = cursor.value;
                break;
              }
              cursor = await cursor.continue();
            }
          }
          if (active && saved && JSON.stringify(latest.current) === initial) {
            if (saved.operationId) operationId.current = saved.operationId;
            const local = saved.value;
            const base = saved.base;
            const remote = latest.current as any;
            let conflict = false;
            const merged: any = { ...remote };
            if (name.endsWith(':new')) Object.assign(merged, local);
            else
              for (const field of Object.keys(local ?? {})) {
                if (JSON.stringify(local[field]) !== JSON.stringify(base?.[field])) {
                  if (
                    JSON.stringify(remote?.[field]) !== JSON.stringify(base?.[field]) &&
                    JSON.stringify(remote?.[field]) !== JSON.stringify(local[field])
                  )
                    conflict = true;
                  merged[field] = local[field];
                }
              }
            if (conflict) {
              setRecovery(saved);
              setStatus('本地输入与云端冲突，原始内容已保留，请核对恢复副本');
            } else {
              restore(merged);
              setStatus('已恢复本地输入，请核对后保存');
            }
          }
        } finally {
          d.close();
          if (active) {
            loading.current = false;
            setReady(key);
          }
        }
      })
      .catch(() => {
        setStatus('本地保存失败，请备份输入');
      });
    return () => {
      active = false;
    };
  }, [key, value === null]);
  useEffect(() => {
    if (
      !inCloud() ||
      !key ||
      loading.current ||
      ready !== key ||
      !dirty ||
      recovery ||
      value === null
    )
      return;
    void database()
      .then(async (d) => {
        try {
          await d.put(
            'drafts',
            {
              value,
              operationId: operationId.current,
              base: original.current,
              at: new Date().toISOString(),
            },
            key,
          );
          setStatus('本地已保存，待提交');
        } finally {
          d.close();
        }
      })
      .catch(() => setStatus('本地保存失败，请备份输入'));
  }, [key, value, dirty, ready, recovery]);
  return {
    status,
    operationId: operationId.current,
    recovery,
    async clear() {
      if (!key) return;
      const d = await database();
      try {
        const saved = await d.get('drafts', key);
        if (JSON.stringify(saved?.value) === JSON.stringify(latest.current))
          await d.delete('drafts', key);
      } finally {
        d.close();
      }
    },
  };
}
export async function confirmEditorSnapshots(data: Record<string, any>) {
  const d = await database();
  try {
    const tx = d.transaction('drafts', 'readwrite');
    let cursor = await tx.store.openCursor();
    const owner = verifiedOwner();
    const collections: Record<string, string> = {
      project: 'projects',
      trade: 'trades',
      task: 'tasks',
      purchase: 'purchases',
      note: 'notes',
      person: 'people',
    };
    while (cursor) {
      const parts = JSON.parse(String(cursor.key));
      const draft = cursor.value.value;
      const kind = String(parts[2]).split(':')[1];
      if (
        owner &&
        parts[0] === owner.workspaceId &&
        parts[1] === owner.id &&
        String(parts[2]).startsWith('editor:') &&
        draft
      ) {
        const saved = data[collections[kind]]?.find((x: any) => x.id === draft.id);
        if (
          saved &&
          Object.keys(draft)
            .filter((k) => k !== 'updatedAt')
            .every((k) => JSON.stringify(draft[k]) === JSON.stringify(saved[k]))
        )
          await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  } finally {
    d.close();
  }
}
export async function archiveEditor(name: string) {
  const owner = verifiedOwner();
  if (!owner) return;
  const d = await database();
  try {
    const tx = d.transaction('drafts', 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const parts = JSON.parse(String(cursor.key));
      if (parts[0] === owner.workspaceId && parts[1] === owner.id && parts[2] === name) {
        await tx.store.put(
          cursor.value,
          JSON.stringify([owner.workspaceId, owner.id, 'archive:' + name, crypto.randomUUID()]),
        );
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  } finally {
    d.close();
  }
}
export async function localRecoveryBackup() {
  const owner = verifiedOwner();
  if (!owner) throw Error('请先验证当前账号');
  const d = await database();
  try {
    const inputs = await d.getAll('drafts');
    const keys = await d.getAllKeys('drafts');
    return inputs.flatMap((value, i) => {
      const parts = JSON.parse(String(keys[i]));
      return parts[0] === owner.workspaceId && parts[1] === owner.id
        ? [{ key: keys[i], ...value }]
        : [];
    });
  } finally {
    d.close();
  }
}
export async function confirmRecordSnapshots(
  owner: { id: string; workspaceId: string },
  requestId: string,
  value: unknown,
) {
  const submitted = recordValue.safeParse(value);
  if (!submitted.success) return;
  const d = await database();
  try {
    const tx = d.transaction('drafts', 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const parts = JSON.parse(String(cursor.key));
      const snapshot = cursor.value;
      const parsed = recordValue.safeParse(snapshot.value);
      if (
        parts[0] === owner.workspaceId &&
        parts[1] === owner.id &&
        snapshot.operationId === requestId &&
        parsed.success &&
        JSON.stringify(parsed.data) === JSON.stringify(submitted.data)
      )
        await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  } finally {
    d.close();
  }
}
