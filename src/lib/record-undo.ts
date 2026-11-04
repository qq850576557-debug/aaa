import { businessUndo } from './undo-manager';
import { recordData, type WorkRecord } from './records';
import { canonical } from './history';
let cacheScope = '';
let cacheGeneration = -1;
function ensureScope() {
  if (cacheScope !== businessUndo.scope || cacheGeneration !== businessUndo.generation) {
    records.clear();
    replayed.clear();
    cacheScope = businessUndo.scope;
    cacheGeneration = businessUndo.generation;
  }
}
const records = new Map<string, WorkRecord>();
const replayed = new Map<string, number>();
const tracked = new Set<string>();
export function observeRecords(value: unknown) {
  ensureScope();
  const v = value as { records?: WorkRecord[] };
  if (Array.isArray(v?.records))
    for (const r of v.records)
      if (r.id && typeof r.title === 'string' && (records.get(r.id)?.version ?? 0) <= r.version)
        records.set(r.id, r);
}
export function recordBefore(path: string) {
  ensureScope();
  return structuredClone(records.get(decodeURIComponent(path.slice(9))) ?? null);
}
export function rememberRecord(
  before: WorkRecord | null,
  after: WorkRecord,
  requestId: string,
  scope: string,
) {
  ensureScope();
  if ((records.get(after.id)?.version ?? 0) <= after.version) records.set(after.id, after);
  if (tracked.has(requestId) || scope !== businessUndo.scope) return;
  tracked.add(requestId);
  if (tracked.size > 1000) tracked.delete(tracked.values().next().value!);
  if (
    before &&
    canonical({ ...recordData(before), deleted: before.deleted }) ===
      canonical({ ...recordData(after), deleted: after.deleted })
  )
    return;
  const generation = businessUndo.generation;
  let failedRequest = '';
  let expected = after;
  const apply = async (value: WorkRecord | null) => {
    const { queueCloudRecord } = await import('./cloud');
    const { pendingRecords, verifiedOwner } = await import('./record-outbox');
    if (scope !== businessUndo.scope || generation !== businessUndo.generation)
      throw Error('账号或编辑会话已切换');
    const owner = verifiedOwner();
    if (
      owner &&
      (await pendingRecords(owner)).some(
        (e) => e.path === '/records/' + encodeURIComponent(expected.id),
      )
    )
      throw Error('此事项仍有前序保存，请等待同步完成或先核对冲突。');
    const previous = records.get(expected.id);
    if (previous && previous.version !== expected.version) {
      if (
        replayed.get(expected.id) === previous.version &&
        canonical({ ...recordData(previous), deleted: previous.deleted }) ===
          canonical({ ...recordData(expected), deleted: expected.deleted })
      )
        expected = previous;
      else throw Error('该事项已有后续修改，不能撤销；当前内容已保留。');
    }
    const remove = !value || value.deleted;
    const body = {
      requestId: crypto.randomUUID(),
      version: expected.version,
      ...(remove
        ? {}
        : { value: recordData(value), ...(expected.deleted ? { restore: true } : {}) }),
    };
    if (scope !== businessUndo.scope || generation !== businessUndo.generation)
      throw Error('账号或编辑会话已切换');
    const queue = await businessUndo.withoutCapture(() =>
      queueCloudRecord(
        '/records/' + encodeURIComponent(expected.id),
        remove ? 'DELETE' : 'PUT',
        body,
      ),
    );
    const optimistic = {
      ...(value ?? expected),
      id: expected.id,
      version: expected.version + 1,
      deleted: remove,
    };
    window.dispatchEvent(
      new CustomEvent('chunmo-record-optimistic', {
        detail: { id: expected.id, record: optimistic, scope, generation },
      }),
    );
    try {
      expected = await queue.completion;
      if (scope === businessUndo.scope && generation === businessUndo.generation) {
        records.set(expected.id, expected);
        replayed.set(expected.id, expected.version);
      }
    } catch (e) {
      if ((e as { status?: number }).status === 409) failedRequest = body.requestId;
      window.dispatchEvent(
        new CustomEvent('chunmo-record-optimistic', {
          detail: { id: expected.id, record: null, scope, generation },
        }),
      );
      window.dispatchEvent(new Event('chunmo-records-changed'));
      throw e;
    }
  };
  businessUndo.push(
    {
      label: before ? (after.deleted ? '删除事项' : '编辑事项') : '新增事项',
      undo: () => apply(before),
      redo: () => apply(after),
      discard: async () => {
        const { cloudApi } = await import('./cloud');
        const { finishSupersededRecord, pendingRecords, verifiedOwner, signalOutbox } =
          await import('./record-outbox');
        if (scope !== businessUndo.scope || generation !== businessUndo.generation)
          throw Error('编辑会话已切换');
        await cloudApi('/records/' + encodeURIComponent(expected.id) + '/history');
        if (scope !== businessUndo.scope || generation !== businessUndo.generation)
          throw Error('编辑会话已切换');
        if (failedRequest) await finishSupersededRecord(failedRequest);
        const owner = verifiedOwner();
        const pending = owner ? await pendingRecords(owner) : [];
        const { assessmentDrafts } = await import('./assessment-sync');
        const drafts = await assessmentDrafts(owner);
        signalOutbox(
          pending.some((e) => e.blocked) || drafts.some((d) => d.blocked)
            ? '存在待处理冲突'
            : pending.length || drafts.length
              ? '本地已保存，正在上传'
              : '云端已保存',
        );
        window.dispatchEvent(new Event('chunmo-records-changed'));
      },
    },
    true,
  );
}
