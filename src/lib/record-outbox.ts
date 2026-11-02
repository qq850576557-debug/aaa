import { confirmRecordSnapshots } from './useEditorJournal';
import { openDB } from 'idb';
export type Owner = { id: string; workspaceId: string };
type Entry = { owner: Owner; path: string; method: string; body: any; blocked?: boolean };
const db = () =>
  openDB('chunmo-record-outbox', 1, {
    upgrade(d) {
      d.createObjectStore('pending');
    },
  });
const key = (e: Entry) => JSON.stringify([e.owner.workspaceId, e.owner.id, e.body.requestId]);
let current: Owner | undefined;
let transport: ((path: string, method: string, body: unknown) => Promise<any>) | undefined;
const flights = new Map<string, Promise<any>>();
export function verifiedOwner() {
  return current;
}
function signal(state: string) {
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
      if (entries.some((e) => e.blocked)) signal('存在待处理数据冲突，本地内容已保留');
      for (const e of entries) if (!e.blocked) void deliver(e).catch(() => {});
    })
    .catch(() => signal('本地存储异常，请保留页面并备份'));
}
function deliver(entry: Entry): Promise<any> {
  const id = key(entry);
  if (flights.has(id)) return flights.get(id)!;
  const run = (async () => {
    let attempt = 0;
    for (;;) {
      if (current?.id !== entry.owner.id || current?.workspaceId !== entry.owner.workspaceId)
        throw Error('账号已变化，原账号待上传数据已保留');
      try {
        signal('正在上传');
        const result = await transport!(entry.path, entry.method, entry.body);
        if (!result || typeof result.id !== 'string' || !Number.isInteger(result.version))
          throw Object.assign(Error('事项响应无效，保存结果未确认'), { status: 0 });
        await confirmRecordSnapshots(entry.owner, entry.body.requestId, entry.body.value);
        const d = await db();
        try {
          await d.delete('pending', id);
        } finally {
          d.close();
        }
        const remaining = await pendingRecords(entry.owner);
        signal(
          remaining.some((e) => e.blocked)
            ? '存在待处理数据冲突，本地内容已保留'
            : remaining.length
              ? '本地已保存，正在上传'
              : '云端已保存',
        );
        window.dispatchEvent(
          new CustomEvent('chunmo-record-uploaded', {
            detail: { requestId: entry.body.requestId, record: result },
          }),
        );
        window.dispatchEvent(new Event('chunmo-records-changed'));
        return result;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
          const d = await db();
          try {
            await d.put('pending', { ...entry, blocked: true }, id);
          } finally {
            d.close();
          }
          signal(status === 409 ? '存在数据冲突，完整本地内容已保留' : '上传失败，本地内容已保留');
          throw error;
        }
        signal('上传失败，本地已保存，等待重试');
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
  })().finally(() => flights.delete(id));
  flights.set(id, run);
  return run;
}
export async function durableRecord(path: string, method: string, body: any) {
  if (!current) throw Error('尚未验证当前账号，未发送事项保存');
  const entry: Entry = { owner: { ...current }, path, method, body: structuredClone(body) };
  const d = await db();
  try {
    const tx = d.transaction('pending', 'readwrite');
    const previous = await tx.store.get(key(entry));
    if (previous && JSON.stringify(previous.body) !== JSON.stringify(entry.body))
      throw Error('同一提交编号不能改写内容，原记录已保留');
    await tx.store.put(entry, key(entry));
    await tx.done;
  } finally {
    d.close();
  }
  signal('本地已保存');
  return deliver(entry);
}
