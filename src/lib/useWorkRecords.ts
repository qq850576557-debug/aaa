import { pendingRecords, verifiedOwner } from './record-outbox';
import { savedFeedback, failedFeedback } from '../components/SaveFeedback';
import type { LegacyLink } from './legacy-records';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudApi } from './cloud';
import { recordData, type WorkRecord } from './records';

/** One nonblocking source shared by the date views and project board. */
export function useWorkRecords(enabled: boolean) {
  const [legacyLinks, setLegacyLinks] = useState<LegacyLink[]>([]);
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const mutations = useRef(new Map<string, { key: string; requestId: string; busy: boolean }>());
  const queuedIds = useRef(new Set<string>());
  const active = useRef(false),
    sequence = useRef(0);
  const load = useCallback(async () => {
    if (!active.current) return;
    const token = ++sequence.current;
    try {
      const result = await cloudApi<{ records: WorkRecord[]; legacyLinks?: LegacyLink[] }>(
        '/records',
      );
      if (active.current && token === sequence.current) {
        setRecords(result.records);
        setLegacyLinks(result.legacyLinks ?? []);
        const owner = verifiedOwner();
        if (owner) {
          const entries = await pendingRecords(owner);
          const blocked = entries.filter((e) => e.blocked);
          if (active.current && token === sequence.current) {
            for (const e of entries) {
              if (e.path.startsWith('/records/')) {
                const id = decodeURIComponent(e.path.slice(9));
                if (e.blocked) queuedIds.current.delete(id);
                else queuedIds.current.add(id);
              }
            }
            setBusyIds([
              ...new Set([
                ...queuedIds.current,
                ...Array.from(mutations.current)
                  .filter(([, v]) => v.busy)
                  .map(([id]) => id),
              ]),
            ]);
          }
          if (active.current && token === sequence.current)
            setError(
              blocked.length
                ? `事项同步失败：${blocked[0].message ?? '存在待处理冲突'}；完整本地内容已保留，请核对原事项或恢复副本。`
                : '',
            );
        } else setError('');
      }
    } catch (e) {
      if (active.current && token === sequence.current) setError(String(e));
    } finally {
      if (active.current && token === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    active.current = enabled;
    if (!enabled) return;
    setLoading(true);
    void load();
    const queued = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail.path;
      const id = path.startsWith('/records/') ? decodeURIComponent(path.slice(9)) : '';
      if (id) {
        ++sequence.current;
        queuedIds.current.add(id);
        setBusyIds((old) => [...new Set([...old, id])]);
      }
    };
    const uploaded = (e: Event) => {
      const record = (e as CustomEvent<{ record: WorkRecord }>).detail.record;
      ++sequence.current;
      queuedIds.current.delete(record.id);
      setRecords((old) => [
        ...old.filter((x) => x.id !== record.id),
        ...(record.deleted ? [] : [record]),
      ]);
      setBusyIds((old) => old.filter((id) => id !== record.id));
    };
    window.addEventListener('chunmo-record-uploaded', uploaded);
    window.addEventListener('chunmo-record-queued', queued);
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('chunmo-records-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active.current = false;
      ++sequence.current;
      window.removeEventListener('chunmo-records-changed', refresh);
      window.removeEventListener('chunmo-record-queued', queued);
      window.removeEventListener('chunmo-record-uploaded', uploaded);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled, load]);
  const accept = useCallback((record: WorkRecord) => {
    ++sequence.current;
    setRecords((old) => [
      ...old.filter((x) => x.id !== record.id),
      ...(record.deleted ? [] : [record]),
    ]);
    window.dispatchEvent(new Event('chunmo-records-changed'));
  }, []);
  const toggle = async (record: WorkRecord, remove = false) => {
    const payload = remove
      ? { version: record.version }
      : {
          value: {
            ...recordData(record),
            status: record.status === '已完成' ? '待执行' : '已完成',
          },
          version: record.version,
        };
    const key = JSON.stringify(payload);
    let pending = mutations.current.get(record.id);
    if (pending?.busy) return;
    if (pending?.key !== key) {
      pending = { key, requestId: crypto.randomUUID(), busy: false };
      mutations.current.set(record.id, pending);
    }
    pending.busy = true;
    setBusyIds((old) => [...old, record.id]);
    try {
      accept(
        await cloudApi<WorkRecord>(
          `/records/${encodeURIComponent(record.id)}`,
          remove ? 'DELETE' : 'PUT',
          {
            ...payload,
            requestId: pending.requestId,
          },
        ),
      );
      savedFeedback('toggle-' + pending.requestId, 'record');
      mutations.current.delete(record.id);
      setError('');
    } catch (e) {
      failedFeedback();
      setError(`${String(e)}；原记录未丢弃，请核对后重试。`);
    } finally {
      pending.busy = false;
      setBusyIds((old) => old.filter((x) => x !== record.id));
    }
  };
  return {
    records,
    legacyLinks,
    loading,
    error,
    load,
    accept,
    toggle,
    remove: (r: WorkRecord) => toggle(r, true),
    busyIds,
  };
}
export type RecordSource = ReturnType<typeof useWorkRecords>;
