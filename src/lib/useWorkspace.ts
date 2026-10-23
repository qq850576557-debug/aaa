import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyData, type Data } from './model';
import { loadData, saveData } from './storage';
export function useWorkspace() {
  const [data, setData] = useState<Data>(emptyData);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('正在读取');
  const [error, setError] = useState('');
  const current = useRef(data);
  const queue = useRef(Promise.resolve());
  const rev = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    loadData()
      .then((d) => {
        if (active) {
          current.current = d;
          setData(d);
          setReady(true);
          setStatus('已保存');
        }
      })
      .catch((e) => {
        if (active) {
          setError(`无法读取本地数据：${String(e)}。请检查浏览器存储权限；未覆盖原有数据。`);
          setStatus('读取失败');
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const persist = useCallback((d: Data) => {
    const version = ++rev.current;
    pending.current = true;
    setStatus('正在保存');
    setError('');
    queue.current = queue.current
      .catch(() => {})
      .then(() => saveData(d))
      .then(() => {
        if (version === rev.current) {
          pending.current = false;
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
    (fn: (d: Data) => Data) => {
      if (!ready) return;
      const d = fn(current.current);
      current.current = d;
      setData(d);
      void persist(d);
    },
    [ready, persist],
  );
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (pending.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  return { data, ready, status, error, update, retry: () => persist(current.current) };
}
