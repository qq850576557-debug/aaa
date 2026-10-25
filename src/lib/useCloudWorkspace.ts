import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyData, parseBackup, prepareWorkspace, type Data } from './model';
import { emptyHistory, validateHistory } from './history';
import { cloudApi, cloudSession, CloudError, type CloudState, type CloudUser } from './cloud';
import type { SaveOptions } from './storage';
export function useCloudWorkspace(enabled: boolean) {
  const [data, setData] = useState<Data>(emptyData),
    [savedData, setSavedData] = useState<Data>(emptyData),
    [history, setHistory] = useState(emptyHistory),
    [user, setUser] = useState<CloudUser | null>(null),
    [ready, setReady] = useState(false),
    [status, setStatus] = useState('正在读取'),
    [error, setError] = useState('');
  const current = useRef(data),
    revision = useRef(0),
    pending = useRef(false),
    blocked = useRef(false),
    remote = useRef(false),
    sequence = useRef(0),
    queue = useRef<Promise<unknown>>(Promise.resolve());
  const apply = useCallback((s: CloudState) => {
    const d = prepareWorkspace(parseBackup(s.data));
    validateHistory(s.history);
    current.current = d;
    revision.current = s.revision;
    setData(d);
    setSavedData(d);
    setHistory(s.history);
    setReady(true);
    setStatus('已保存');
    setError('');
  }, []);
  const interacting = () =>
    !!document.querySelector(
      'dialog[open],.task-bar.dragging,.range-preview,.trade-row.sorting,.project-card.sorting',
    );
  const refresh = useCallback(async () => {
    if (interacting()) {
      remote.current = true;
      return;
    }
    const seq = sequence.current,
      s = await cloudApi<CloudState>('/workspace');
    if (pending.current || blocked.current || seq !== sequence.current || interacting()) {
      remote.current = true;
      return;
    }
    apply(s);
  }, [apply]);
  useEffect(() => {
    if (!enabled) return;
    let active = true,
      events: EventSource | undefined;
    void cloudSession()
      .then(async (u) => {
        if (!active) return;
        setUser(u);
        await refresh();
        if (!active) return;
        events = new EventSource('/api/events');
        events.addEventListener('revision', (event) => {
          const value = JSON.parse((event as MessageEvent).data);
          if (value.revision !== revision.current)
            void refresh().catch((e) => {
              setError(String(e));
            });
        });
        events.addEventListener('session-expired', () => {
          blocked.current = true;
          setUser(null);
          if (!pending.current) {
            current.current = emptyData();
            setData(emptyData());
            setSavedData(emptyData());
            setHistory(emptyHistory());
            setReady(false);
          }
          setStatus('登录失效');
          setError('云端会话已失效；未保存草稿仍在当前页面，请先备份，再重新登录。');
          events?.close();
        });
      })
      .catch((e) => {
        if (active) {
          setStatus('读取失败');
          setError(String(e));
        }
      });
    const deferred = setInterval(() => {
      if (remote.current && !pending.current && !blocked.current && !interacting()) {
        remote.current = false;
        void refresh().catch((e) => setError(String(e)));
      }
    }, 1000);
    return () => {
      active = false;
      clearInterval(deferred);
      events?.close();
    };
  }, [enabled, refresh]);
  const persist = useCallback(
    (d: Data) => {
      const seq = ++sequence.current;
      pending.current = true;
      setStatus('正在保存');
      setError('');
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (blocked.current) return;
          try {
            const s = await cloudApi<CloudState>('/workspace', 'PUT', {
              revision: revision.current,
              data: d,
            });
            revision.current = s.revision;
            setSavedData(s.data);
            setHistory(s.history);
            if (seq === sequence.current) {
              pending.current = false;
              apply(s);
              if (remote.current) {
                remote.current = false;
                await refresh();
              }
            }
          } catch (e) {
            blocked.current =
              e instanceof CloudError && (e.status === 409 || e.status === 401 || e.status === 403);
            setStatus(e instanceof CloudError && e.status === 409 ? '保存冲突' : '保存失败');
            setError(
              `${String(e)}。草稿未写入本地库，也未静默覆盖云端；请先备份，再重新读取云端。`,
            );
          }
        });
      return queue.current;
    },
    [apply, refresh],
  );
  const update = useCallback(
    (fn: (d: Data) => Data, options?: SaveOptions) => {
      if (!ready) return;
      if (blocked.current) throw Error('请先处理保存冲突并重新读取');
      if (options?.history || options?.source)
        throw Error('云空间请使用云端账号中的预览导入流程，不能覆盖整个空间');
      const d = prepareWorkspace(parseBackup(fn(current.current)));
      current.current = d;
      setData(d);
      void persist(d);
    },
    [persist, ready],
  );
  const restoreVersion = useCallback(
    async (id: string) => {
      if (pending.current || blocked.current) throw Error('请先保存或处理冲突');
      setStatus('正在恢复');
      try {
        apply(
          await cloudApi<CloudState>('/history/restore', 'POST', {
            revision: revision.current,
            id,
          }),
        );
      } catch (e) {
        setStatus('已保存');
        throw e;
      }
    },
    [apply],
  );
  const changeDeadline = useCallback(
    async (id: string, date: string, reason: string) => {
      if (pending.current || blocked.current) throw Error('请先完成保存或处理冲突');
      pending.current = true;
      setStatus('正在保存');
      try {
        const s = await cloudApi<CloudState>(
          `/purchases/${encodeURIComponent(id)}/deadline`,
          'POST',
          { revision: revision.current, date, reason },
        );
        apply(s);
      } catch (e) {
        setStatus('变更失败');
        throw e;
      } finally {
        pending.current = false;
      }
    },
    [apply],
  );
  const reloadCloud = useCallback(async () => {
    await queue.current;
    const s = await cloudApi<CloudState>('/workspace');
    blocked.current = false;
    pending.current = false;
    remote.current = false;
    ++sequence.current;
    apply(s);
  }, [apply]);
  useEffect(() => {
    if (!enabled) return;
    const guard = (e: BeforeUnloadEvent) => {
      if (pending.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [enabled]);
  return {
    data,
    savedData,
    history,
    historyError: '',
    ready,
    status,
    error,
    update,
    restoreVersion,
    retry: () => {
      if (blocked.current) {
        setError('存在冲突或权限变化，请先备份草稿，再重新读取云端。');
        return Promise.resolve();
      }
      return persist(current.current);
    },
    hasUnsavedChanges: pending.current,
    isCloud: true,
    cloudUser: user,
    reloadCloud,
    changeDeadline,
  };
}
