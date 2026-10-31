import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudApi } from './cloud';
import { recordData, type WorkRecord } from './records';

/** One nonblocking source shared by the date views and project board. */
export function useWorkRecords(enabled: boolean) {
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const mutations = useRef(new Map<string, { key: string; requestId: string; busy: boolean }>());
  const active = useRef(false),
    sequence = useRef(0);
  const load = useCallback(async () => {
    if (!active.current) return;
    const token = ++sequence.current;
    try {
      const result = await cloudApi<{ records: WorkRecord[] }>('/records');
      if (active.current && token === sequence.current) {
        setRecords(result.records);
        setError('');
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
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('chunmo-records-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active.current = false;
      ++sequence.current;
      window.removeEventListener('chunmo-records-changed', refresh);
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
  const toggle = async (record: WorkRecord) => {
    const payload = {
      value: { ...recordData(record), status: record.status === '已完成' ? '待执行' : '已完成' },
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
        await cloudApi<WorkRecord>(`/records/${encodeURIComponent(record.id)}`, 'PUT', {
          ...payload,
          requestId: pending.requestId,
        }),
      );
      mutations.current.delete(record.id);
      setError('');
    } catch (e) {
      setError(`${String(e)}；原记录未丢弃，请核对后重试。`);
    } finally {
      pending.busy = false;
      setBusyIds((old) => old.filter((x) => x !== record.id));
    }
  };
  return { records, loading, error, load, accept, toggle, busyIds };
}
export type RecordSource = ReturnType<typeof useWorkRecords>;
