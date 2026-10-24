import { openDB } from 'idb';
import { emptyData, parseBackup, prepareWorkspace, type Data } from './model';
import {
  canonical,
  emptyHistory,
  recordChanges,
  restoreBefore,
  retainHistory,
  validateHistory,
  type History,
  mergeHistory,
} from './history';
// Keep the existing database/store and legacy business-data key. No destructive migration.
const db = () =>
  openDB('chunmo-workspace', 1, {
    upgrade(db) {
      db.createObjectStore('workspace');
    },
  });
export async function loadData(): Promise<Data> {
  const conn = await db();
  try {
    const raw = await conn.get('workspace', 'data');
    return raw === undefined ? emptyData() : parseBackup(raw);
  } finally {
    conn.close();
  }
}
export async function loadHistory(): Promise<History> {
  const conn = await db();
  try {
    const raw = await conn.get('workspace', 'history');
    return raw === undefined ? emptyHistory() : retainHistory(validateHistory(raw));
  } finally {
    conn.close();
  }
}
// Cleanup is separate: failure never prevents loading current business data.
export async function pruneHistory(now = Date.now()) {
  const conn = await db();
  try {
    const tx = conn.transaction('workspace', 'readwrite'),
      store = tx.objectStore('workspace');
    try {
      const raw = await store.get('history');
      if (raw !== undefined) await store.put(retainHistory(validateHistory(raw), now), 'history');
      await tx.done;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
      await tx.done.catch(() => {});
      throw e;
    }
  } finally {
    conn.close();
  }
}
export type SaveOptions = { history?: History; source?: string };
async function write(data: Data, expected?: Data, revisionId?: string, options?: SaveOptions) {
  const valid = parseBackup(data),
    conn = await db();
  const tx = conn.transaction('workspace', 'readwrite'),
    store = tx.objectStore('workspace');
  try {
    const [raw, rawHistory] = await Promise.all([store.get('data'), store.get('history')]);
    const previous = raw === undefined ? emptyData() : prepareWorkspace(parseBackup(raw));
    if (expected && canonical(previous) !== canonical(prepareWorkspace(expected)))
      throw Error('其他标签页已修改数据，请先备份未保存内容并重新读取；未覆盖现有数据');
    const existingHistory = rawHistory === undefined ? emptyHistory() : validateHistory(rawHistory);
    const history = options?.history
      ? mergeHistory(existingHistory, options.history)
      : existingHistory;
    const now = Date.now();
    const target = revisionId ? history.records.find((r) => r.id === revisionId) : undefined;
    const next = revisionId ? restoreBefore(previous, history, revisionId, now) : valid;
    const result = recordChanges(
      previous,
      next,
      history,
      now,
      target
        ? { scope: target.scope, source: target.id }
        : options?.source
          ? { scope: '*', source: options.source }
          : undefined,
    );
    await store.put(result.data, 'data');
    await store.put(result.history, 'history');
    await tx.done;
    return result;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* already aborted */
    }
    await tx.done.catch(() => {});
    throw e;
  } finally {
    conn.close();
  }
}
export async function saveData(data: Data, expected?: Data, options?: SaveOptions) {
  return write(data, expected, undefined, options);
}
export async function restoreRevision(expected: Data, revisionId: string) {
  return write(expected, expected, revisionId);
}
