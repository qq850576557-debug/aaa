import { recordBefore, rememberRecord } from './record-undo';
import { businessUndo } from './undo-manager';
import { confirmRecordSnapshots } from './useEditorJournal';
import { openDB } from 'idb';
export type Owner = { id: string; workspaceId: string };
export type OutboxEntry = {
  undoBefore?: import('./records').WorkRecord | null;
  undoScope?: string;
  owner: Owner;
  path: string;
  method: string;
  body: any;
  blocked?: boolean;
  failureStatus?: number;
  message?: string;
};
export const outboxDB = () =>
  openDB('chunmo-record-outbox', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending');
      if (!d.objectStoreNames.contains('assessmentDrafts')) d.createObjectStore('assessmentDrafts');
    },
  });
const db = outboxDB;
type Entry = OutboxEntry;
const key = (e: Entry) => JSON.stringify([e.owner.workspaceId, e.owner.id, e.body.requestId]);
let current: Owner | undefined;
let transport: ((path: string, method: string, body: unknown) => Promise<any>) | undefined;
const flights = new Map<string, Promise<any>>();
const flightBodies = new Map<string, string>();
export function verifiedOwner() {
  return current;
}
export function signalOutbox(state: string) {
  window.dispatchEvent(new CustomEvent('chunmo-outbox-status', { detail: state }));
}
export async function pendingRecords(owner: Owner) {
  const d = await db();
  try {
    return ((await d.getAll('pending')) as Entry[]).filter(
      (e) => e.owner.id === owner.id && e.owner.workspaceId === owner.workspaceId,
    );
  } finally {
    d.close();
  }
}
export function startRecordSync(owner: Owner, send: typeof transport) {
  current = owner;
  transport = send;
  void pendingRecords(owner)
    .then((entries) => {
      if (entries.some((e) => e.blocked)) signalOutbox('存在待处理数据冲突，本地内容已保留');
      for (const e of entries)
        if (
          !e.blocked ||
          e.failureStatus === 401 ||
          (e.failureStatus === 403 && e.message?.includes('请求验证'))
        )
          void deliver(e).catch(() => {});
    })
    .catch(() => signalOutbox('本地存储异常，请保留页面并备份'));
}
function deliver(entry: Entry): Promise<any> {
  const id = key(entry);
  if (flights.has(id)) {
    if (flightBodies.get(id) !== JSON.stringify(entry.body))
      return Promise.reject(Error('同一提交编号不能改写内容，原记录已保留'));
    return flights.get(id)!;
  }
  flightBodies.set(id, JSON.stringify(entry.body));
  const run = (async () => {
    let attempt = 0;
    for (;;) {
      if (current?.id !== entry.owner.id || current?.workspaceId !== entry.owner.workspaceId)
        throw Error('账号已变化，原账号待上传数据已保留');
      try {
        signalOutbox('正在上传');
        const result = await transport!(entry.path, entry.method, entry.body);
        const assessment = entry.path === '/assessments/batch';
        if (assessment) {
          const rows = result?.records;
          if (
            !Array.isArray(rows) ||
            rows.length !== entry.body.edits?.length ||
            entry.body.edits.some(
              (e: any) =>
                !rows.some(
                  (r: any) =>
                    r.date === e.date &&
                    r.personId === e.personId &&
                    r.projectId === e.projectId &&
                    r.tradeId === e.tradeId &&
                    typeof r.id === 'string' &&
                    Number.isInteger(r.version) &&
                    r.version > 0 &&
                    r.version >= e.version &&
                    r.version <= e.version + 1 &&
                    Object.entries(e.changes).every(([f, v]) => r[f] === v),
                ),
            )
          )
            throw Object.assign(Error('考核响应无效，保存结果未确认'), { status: 0 });
        } else {
          if (!result || typeof result.id !== 'string' || !Number.isInteger(result.version))
            throw Object.assign(Error('事项响应无效，保存结果未确认'), { status: 0 });
          if (
            (entry.method === 'POST' || entry.undoBefore) &&
            current?.id === entry.owner.id &&
            current.workspaceId === entry.owner.workspaceId
          )
            rememberRecord(
              entry.undoBefore ?? null,
              result,
              entry.body.requestId,
              entry.undoScope ?? '',
            );
          await confirmRecordSnapshots(entry.owner, entry.body.requestId, entry.body.value);
        }
        const d = await db();
        try {
          await d.delete('pending', id);
        } finally {
          d.close();
        }
        if (current?.id === entry.owner.id && current.workspaceId === entry.owner.workspaceId) {
          const remaining = await pendingRecords(entry.owner);
          {
            const cache = await db();
            let draftPending = false;
            try {
              draftPending = (await cache.getAll('assessmentDrafts')).some(
                (d: any) =>
                  d.owner.id === entry.owner.id && d.owner.workspaceId === entry.owner.workspaceId,
              );
            } finally {
              cache.close();
            }
            signalOutbox(
              remaining.some((e) => e.blocked)
                ? '存在待处理数据冲突，本地内容已保留'
                : remaining.length || draftPending
                  ? '本地已保存，正在上传'
                  : '云端已保存',
            );
          }
          window.dispatchEvent(
            new CustomEvent(assessment ? 'chunmo-assessments-uploaded' : 'chunmo-record-uploaded', {
              detail: { requestId: entry.body.requestId, record: result, owner: entry.owner },
            }),
          );
          window.dispatchEvent(
            new Event(assessment ? 'chunmo-assessments-changed' : 'chunmo-records-changed'),
          );
        }
        return result;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
          const d = await db();
          try {
            await d.put(
              'pending',
              {
                ...entry,
                blocked: true,
                failureStatus: status,
                message: error instanceof Error ? error.message : String(error),
              },
              id,
            );
          } finally {
            d.close();
          }
          window.dispatchEvent(
            new Event(
              entry.path === '/assessments/batch'
                ? 'chunmo-assessments-changed'
                : 'chunmo-records-changed',
            ),
          );
          signalOutbox(
            status === 409 ? '存在数据冲突，完整本地内容已保留' : '上传失败，本地内容已保留',
          );
          throw error;
        }
        signalOutbox('上传失败，本地已保存，等待重试');
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            window.removeEventListener('online', done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)));
          window.addEventListener('online', done, { once: true });
        });
      }
    }
  })().finally(() => {
    flights.delete(id);
    flightBodies.delete(id);
  });
  flights.set(id, run);
  return run;
}
async function persistRecord(path: string, method: string, body: any) {
  if (!current) throw Error('尚未验证当前账号，未发送事项保存');
  const entry: Entry = {
    owner: { ...current },
    path,
    method,
    body: structuredClone(body),
    ...(path === '/records' || path.startsWith('/records/')
      ? {
          undoBefore: (() => {
            const before = recordBefore(path);
            return method === 'POST' || before?.version === body.version ? before : null;
          })(),
          undoScope: businessUndo.replaying ? undefined : businessUndo.scope,
        }
      : {}),
  };
  const d = await db();
  try {
    const tx = d.transaction('pending', 'readwrite');
    const previous = await tx.store.get(key(entry));
    if (previous) {
      entry.undoBefore = previous.undoBefore;
      entry.undoScope = previous.undoScope;
    }
    if (previous && JSON.stringify(previous.body) !== JSON.stringify(entry.body))
      throw Error('同一提交编号不能改写内容，原记录已保留');
    const running = flightBodies.get(key(entry));
    if (running && running !== JSON.stringify(entry.body))
      throw Error('同一提交编号不能改写内容，原记录已保留');
    // A receipt can already be acknowledged while another caller is attaching
    // to its in-flight promise. Do not recreate a deleted pending entry then.
    if (previous || !flights.has(key(entry))) await tx.store.put(entry, key(entry));
    await tx.done;
  } finally {
    d.close();
  }
  signalOutbox('本地已保存');
  window.dispatchEvent(new CustomEvent('chunmo-record-queued', { detail: { path } }));
  return entry;
}

export async function durableRecord(path: string, method: string, body: any) {
  return deliver(await persistRecord(path, method, body));
}
export async function queueRecord(path: string, method: string, body: any) {
  const entry = await persistRecord(path, method, body);
  const completion = new Promise<any>((resolve, reject) => {
    setTimeout(() => {
      void deliver(entry).then(resolve, reject);
    }, 0);
  });
  void completion.catch(() => {});
  return { completion };
}

/** A blocked receipt is removed only after an explicitly superseding save is confirmed. */
export async function finishSupersededRecord(requestId: string) {
  if (!current) throw Error('账号未验证');
  const d = await db();
  try {
    const id = JSON.stringify([current.workspaceId, current.id, requestId]);
    const old = await d.get('pending', id);
    if (old?.blocked) await d.delete('pending', id);
  } finally {
    d.close();
  }
}
