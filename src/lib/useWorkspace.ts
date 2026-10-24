import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyData, prepareWorkspace, type Data } from './model';
import { emptyHistory } from './history';
import {
  loadData,
  loadHistory,
  saveData,
  restoreRevision,
  pruneHistory,
  type SaveOptions,
} from './storage';
export function useLocalWorkspace(enabled = true) {
  const [savedData, setSavedData] = useState<Data>(emptyData);
  const [data, setData] = useState<Data>(emptyData),
    [history, setHistory] = useState(emptyHistory);
  const [ready, setReady] = useState(false),
    [status, setStatus] = useState('正在读取'),
    [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const current = useRef(data),
    saved = useRef(data),
    queue = useRef<Promise<unknown>>(Promise.resolve());
  const rev = useRef(0),
    pending = useRef(false),
    restoring = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    loadData()
      .then(async (loaded) => {
        const d = prepareWorkspace(loaded);
        if (!active) return;
        current.current = d;
        saved.current = d;
        setSavedData(d);
        setData(d);
        setReady(true);
        setStatus('已保存');
        try {
          const h = await loadHistory();
          if (active) {
            setHistory(h);
            setHistoryError('');
          }
        } catch (e) {
          if (active)
            setHistoryError(`历史读取失败：${String(e)}。业务数据保留；请先备份，不覆盖历史。`);
        }
        void pruneHistory().catch(() => {
          if (active) setHistoryError('历史清理失败，已保留现有数据和版本，稍后重试。');
        });
      })
      .catch((e) => {
        if (active) {
          setError(`无法读取本地数据：${String(e)}。请检查浏览器存储权限；未覆盖原有数据。`);
          setStatus('读取失败');
        }
      });
    const interval = setInterval(() => {
      void loadHistory()
        .then((h) => {
          if (active) setHistory(h);
        })
        .catch(() => {});
      void pruneHistory().catch(() => {});
    }, 60000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);
  const pendingOptions = useRef<SaveOptions | undefined>(undefined);
  const persist = useCallback((d: Data, options?: SaveOptions) => {
    const meta = options ?? pendingOptions.current;
    pendingOptions.current = meta;
    const version = ++rev.current;
    pending.current = true;
    setStatus('正在保存');
    setError('');
    queue.current = queue.current
      .catch(() => {})
      .then(() => saveData(d, saved.current, meta))
      .then((result) => {
        saved.current = result.data;
        setSavedData(result.data);
        setHistory(result.history);
        setHistoryError('');
        if (version === rev.current) {
          pending.current = false;
          pendingOptions.current = undefined;
          current.current = result.data;
          setData(result.data);
          setStatus('已保存');
        }
      })
      .catch((e) => {
        if (version === rev.current) {
          pending.current = true;
          setStatus('保存失败');
          setError(`保存失败：${String(e)}。请立即备份当前数据，并重试保存。`);
        }
      });
    return queue.current;
  }, []);
  const update = useCallback(
    (fn: (d: Data) => Data, options?: SaveOptions) => {
      if (!ready) return;
      if (restoring.current) throw Error('正在恢复版本，请等待完成');
      const d = prepareWorkspace(fn(current.current));
      current.current = d;
      setData(d);
      void persist(d, options);
    },
    [ready, persist],
  );
  const restoreVersion = useCallback(async (revisionId: string) => {
    if (pending.current || restoring.current) throw Error('请先完成当前保存，再恢复历史版本');
    restoring.current = true;
    setStatus('正在恢复');
    try {
      await queue.current;
      const result = await restoreRevision(saved.current, revisionId);
      saved.current = result.data;
      setSavedData(result.data);
      current.current = result.data;
      setData(result.data);
      setHistory(result.history);
      setStatus('已保存');
    } catch (e) {
      setStatus('已保存');
      throw e;
    } finally {
      restoring.current = false;
    }
  }, []);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (pending.current || restoring.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  return {
    data,
    savedData,
    history,
    historyError,
    ready,
    status,
    error,
    update,
    restoreVersion,
    retry: () => persist(current.current),
  };
}
