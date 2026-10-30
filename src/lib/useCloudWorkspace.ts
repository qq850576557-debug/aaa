import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyData, parseBackup, prepareWorkspace, type Data } from './model';
import { canonical, emptyHistory, validateHistory } from './history';
import { cloudApi, cloudSession, CloudError, type CloudState, type CloudUser } from './cloud';
import {
  clearCloudDraft,
  claimDraftTab,
  readCloudDraft,
  writeCloudDraft,
  type CloudDraft,
} from './cloud-drafts';
import { mergeWorkspace, type MergeChoices, type WorkspaceConflict } from './workspace-merge';
import type { SaveOptions } from './storage';
export type SaveConflict = {
  base: Data;
  local: Data;
  current: CloudState;
  fields: WorkspaceConflict[];
};
const interacting = () =>
  !!document.querySelector(
    'dialog[open],.task-bar.dragging,.range-preview,.trade-row.sorting,.project-card.sorting,.person-card.sorting',
  );
const validState = (s: CloudState) => {
  if (!/^[a-f0-9]{64}$/i.test(s.baseProof || ''))
    throw Error('服务端尚未支持安全合并，请更新服务端后重试；草稿未覆盖云端。');
  parseBackup(s.data);
  validateHistory(s.history);
  return s;
};
export function useCloudWorkspace(enabled: boolean, initialUser?: CloudUser) {
  const [data, setData] = useState<Data>(emptyData),
    [savedData, setSavedData] = useState<Data>(emptyData),
    [history, setHistory] = useState(emptyHistory),
    [user, setUser] = useState<CloudUser | null>(initialUser ?? null),
    [ready, setReady] = useState(false),
    [status, setStatus] = useState('正在读取'),
    [error, setError] = useState(''),
    [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null);
  const current = useRef(data),
    baseline = useRef<CloudState | null>(null),
    viewBase = useRef(data),
    pending = useRef(false),
    blocked = useRef(false),
    remote = useRef(false),
    sequence = useRef(0),
    exclusive = useRef(false),
    profile = useRef<CloudUser | null>(null),
    tab = useRef(''),
    inFlight = useRef<CloudDraft['inFlight']>(null),
    working = useRef<Promise<void> | null>(null),
    journal = useRef<Promise<void>>(Promise.resolve()),
    review = useRef<SaveConflict | null>(null),
    alive = useRef(true);
  const showReview = useCallback((s: CloudState, fields: WorkspaceConflict[], message?: string) => {
    const value = { base: viewBase.current, local: current.current, current: s, fields };
    review.current = value;
    setSaveConflict(value);
    baseline.current = s;
    setSavedData(s.data);
    setHistory(s.history);
    blocked.current = true;
    pending.current = true;
    setStatus('保存冲突');
    setError(message || '相同字段已被修改，未覆盖云端。草稿已自动保留，请核对冲突内容。');
  }, []);
  const apply = useCallback((s: CloudState) => {
    validState(s);
    const d = prepareWorkspace(parseBackup(s.data));
    baseline.current = s;
    viewBase.current = d;
    current.current = d;
    setData(d);
    setSavedData(d);
    setHistory(s.history);
    setReady(true);
    setStatus('已保存');
    setError('');
  }, []);
  const stash = useCallback(() => {
    const u = profile.current,
      s = baseline.current;
    if (!u || !s || !tab.current) return Promise.reject(Error('草稿账号尚未就绪'));
    const draft: CloudDraft = {
      version: 1,
      accountId: u.id,
      workspaceId: u.workspaceId,
      tabId: tab.current,
      at: new Date().toISOString(),
      base: { ...s, history: emptyHistory() },
      mergeBase: viewBase.current,
      data: current.current,
      inFlight: inFlight.current,
    };
    // Snapshot before queuing: a later edit must not alter the stored in-flight request.
    const copy = structuredClone(draft);
    journal.current = journal.current.catch(() => {}).then(() => writeCloudDraft(copy));
    return journal.current;
  }, []);
  const clearDraft = useCallback(() => {
    const u = profile.current;
    if (!u) return Promise.resolve();
    const t = tab.current;
    journal.current = journal.current
      .catch(() => {})
      .then(() => clearCloudDraft(u.workspaceId, u.id, t));
    return journal.current;
  }, []);
  const refresh = useCallback(async () => {
    if (interacting() || pending.current || blocked.current) {
      remote.current = true;
      return;
    }
    const seq = sequence.current,
      s = validState(await cloudApi<CloudState>('/workspace'));
    if (pending.current || blocked.current || seq !== sequence.current || interacting()) {
      remote.current = true;
      return;
    }
    remote.current = false;
    apply(s);
  }, [apply]);
  const persist = useCallback((): Promise<void> => {
    if (working.current) return working.current;
    const run = async () => {
      while (alive.current && pending.current && !blocked.current) {
        let created = false,
          dispatched = false;
        try {
          if (!inFlight.current) {
            const s = baseline.current!;
            const m = mergeWorkspace(viewBase.current, current.current, s.data);
            if (m.conflicts.length) {
              showReview(s, m.conflicts);
              await stash();
              return;
            }
            const d = prepareWorkspace(parseBackup(m.data));
            inFlight.current = {
              view: current.current,
              body: {
                revision: s.revision,
                base: s.data,
                baseProof: s.baseProof,
                data: d,
                requestId: crypto.randomUUID(),
              },
            };
            created = true;
          }
          await stash(); // Durable before the request; if storage fails, do not send an unsafe request.
          const sent = inFlight.current!;
          setStatus('正在保存');
          dispatched = true;
          const s = validState(await cloudApi<CloudState>('/workspace', 'PUT', sent.body));
          baseline.current = s;
          viewBase.current = sent.view;
          inFlight.current = null;
          setSavedData(s.data);
          setHistory(s.history);
          const m = mergeWorkspace(sent.view, current.current, s.data);
          if (m.conflicts.length) {
            showReview(s, m.conflicts);
            await stash();
            return;
          }
          // Only edits made after this request remain pending. Never resubmit a stale full snapshot.
          pending.current = canonical(m.data) !== canonical(s.data);
          if (!interacting()) {
            current.current = prepareWorkspace(parseBackup(m.data));
            viewBase.current = s.data;
            setData(current.current);
          } else remote.current = true; // Keep open forms' original baseline until they close/save.
          if (pending.current) await stash();
          else await clearDraft();
          if (!pending.current) {
            setStatus('已保存');
            setError('');
          }
        } catch (e) {
          // A journal failure before a new request was dispatched is a known non-submission.
          // Retain older ambiguous requests, but do not later replay a never-sent stale edit.
          if (created && !dispatched) inFlight.current = null;
          // A 4xx response is definitive; a transport/5xx error is ambiguous and must reuse the receipt ID.
          if (e instanceof CloudError && e.status >= 400 && e.status < 500) inFlight.current = null;
          if (e instanceof CloudError && e.status === 409 && e.details?.current) {
            const s = validState(e.details.current);
            const m = mergeWorkspace(viewBase.current, current.current, s.data);
            showReview(s, m.conflicts, e.message);
          } else {
            blocked.current =
              e instanceof CloudError && [400, 401, 403, 409, 413].includes(e.status);
            setStatus(e instanceof CloudError && e.status === 409 ? '保存冲突' : '保存失败');
            setError(
              `${e instanceof Error ? e.message : String(e)}。未丢弃草稿，请重试保存或核对云端；也可下载紧急备份。`,
            );
          }
          try {
            await stash();
          } catch {
            setError(
              '浏览器无法保留草稿（存储受限或空间不足）。草稿仍在当前页面；请立即下载紧急备份，暂勿关闭页面。',
            );
          }
          return;
        }
      }
    };
    working.current = run().finally(() => {
      working.current = null;
    });
    return working.current;
  }, [clearDraft, showReview, stash]);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    let active = true,
      releaseTab = () => {},
      events: EventSource | undefined;
    const profileUpdated = (event: Event) => {
      const next = (event as CustomEvent<CloudUser>).detail;
      setUser((previous) => (previous?.id === next?.id ? next : previous));
    };
    window.addEventListener('chunmo-profile-updated', profileUpdated);
    // The gate has just verified this identity against the server. Reuse it only
    // for this mount; no workspace snapshot or cross-login session cache is kept.
    void (initialUser ? Promise.resolve(initialUser) : cloudSession())
      .then(async (u) => {
        if (!active) return;
        profile.current = u;
        setUser(u);
        const [s, draft] = await Promise.all([
          cloudApi<CloudState>('/workspace').then(validState),
          (async () => {
            const lease = await claimDraftTab();
            if (!active) {
              lease.release();
              return;
            }
            releaseTab = lease.release;
            tab.current = lease.id;
            return readCloudDraft(u.workspaceId, u.id, lease.id);
          })(),
        ]);
        if (!active) return;
        apply(s);
        if (draft) {
          baseline.current = draft.base;
          viewBase.current = draft.mergeBase;
          current.current = draft.data;
          inFlight.current = draft.inFlight;
          setData(draft.data);
          pending.current = true;
          blocked.current = true;
          setStatus('草稿待恢复');
          setError(
            '已恢复本账号的未提交草稿，未覆盖云端。请重试保存或重新读取云端核对；其他账号无法载入此草稿。',
          );
        }
        events = new EventSource('/api/events');
        events.addEventListener('open', () => window.dispatchEvent(new Event('chunmo-presence')));
        events.addEventListener('presence', () =>
          window.dispatchEvent(new Event('chunmo-presence')),
        );
        events.addEventListener('records', () =>
          window.dispatchEvent(new Event('chunmo-records-changed')),
        );
        window.dispatchEvent(new Event('chunmo-presence'));
        events.addEventListener('revision', (event) => {
          const value = JSON.parse((event as MessageEvent).data);
          if (value.revision !== baseline.current?.revision)
            void refresh().catch((e) => setError(String(e)));
        });
        events.addEventListener('session-expired', () => {
          if (!active) return;
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
          setError('云端会话已失效；未保存草稿按原账号保留，请先备份，再重新登录。');
          window.dispatchEvent(new Event('chunmo-auth-expired'));
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
      if (remote.current && !pending.current && !blocked.current && !interacting())
        void refresh().catch((e) => setError(String(e)));
    }, 1000);
    return () => {
      active = false;
      alive.current = false;
      releaseTab();
      clearInterval(deferred);
      events?.close();
      window.removeEventListener('chunmo-profile-updated', profileUpdated);
    };
  }, [enabled, initialUser, apply, refresh]);
  const update = useCallback(
    (fn: (d: Data) => Data, options?: SaveOptions) => {
      if (!ready) return;
      if (exclusive.current) throw Error('请等待当前恢复或期限变更完成，再继续编辑');
      if (blocked.current) throw Error('请先核对保存冲突或恢复草稿');
      if (options?.history || options?.source)
        throw Error('云空间请使用云端账号中的预览导入流程，不能覆盖整个空间');
      const d = prepareWorkspace(parseBackup(fn(current.current)));
      current.current = d;
      setData(d);
      const seq = ++sequence.current;
      pending.current = true;
      setStatus('正在保存');
      setError('');
      // The worker persists this edit before sending it, including edits queued behind an earlier request.
      void stash().catch(() => setError('浏览器草稿保存失败，请勿关闭页面并下载紧急备份。'));
      const prior = working.current;
      void persist();
      // If an older request fails while this edit is queued, resume this latest edit once
      // after that worker settles. Do not strand it in “saving” or spin on an unchanged error.
      if (prior)
        void prior.then(() => {
          if (seq === sequence.current && pending.current && !blocked.current) void persist();
        });
    },
    [persist, ready, stash],
  );
  const restoreVersion = useCallback(
    async (id: string) => {
      if (pending.current || blocked.current) throw Error('请先保存或处理冲突');
      pending.current = true;
      exclusive.current = true;
      setStatus('正在恢复');
      try {
        apply(
          await cloudApi<CloudState>('/history/restore', 'POST', {
            revision: baseline.current!.revision,
            id,
          }),
        );
      } catch (e) {
        setStatus('恢复未完成');
        throw e;
      } finally {
        pending.current = false;
        exclusive.current = false;
      }
    },
    [apply],
  );
  const changeDeadline = useCallback(
    async (id: string, date: string, reason: string) => {
      if (pending.current || blocked.current) throw Error('请先完成保存或处理冲突');
      pending.current = true;
      exclusive.current = true;
      setStatus('正在保存');
      try {
        apply(
          await cloudApi<CloudState>(`/purchases/${encodeURIComponent(id)}/deadline`, 'POST', {
            revision: baseline.current!.revision,
            date,
            reason,
          }),
        );
      } catch (e) {
        setStatus('变更失败');
        throw e;
      } finally {
        pending.current = false;
        exclusive.current = false;
      }
    },
    [apply],
  );
  const reloadCloud = useCallback(async () => {
    if (interacting()) throw Error('请先关闭编辑弹窗；当前表单内容未被替换。');
    await working.current;
    if (exclusive.current) throw Error('请等待当前操作完成，草稿未被替换');
    if (inFlight.current)
      throw Error('上一提交的结果尚未确认，请先重试保存；重试会沿用原提交编号，不会重复执行。');
    const seq = sequence.current;
    const s = validState(await cloudApi<CloudState>('/workspace'));
    if (seq !== sequence.current || interacting()) {
      remote.current = true;
      throw Error('读取期间产生了新的编辑，未替换草稿；请先完成当前编辑再核对云端。');
    }
    if (pending.current) {
      const m = mergeWorkspace(viewBase.current, current.current, s.data);
      if (m.conflicts.length) {
        showReview(s, m.conflicts);
        await stash();
        return;
      }
      const d = prepareWorkspace(parseBackup(m.data));
      baseline.current = s;
      viewBase.current = s.data;
      current.current = d;
      setData(d);
      setSavedData(s.data);
      setHistory(s.history);
      blocked.current = false;
      review.current = null;
      setSaveConflict(null);
      ++sequence.current;
      await persist();
    } else {
      blocked.current = false;
      apply(s);
    }
  }, [apply, persist, showReview, stash]);
  const resolveSaveConflict = useCallback(
    async (choices: MergeChoices) => {
      const r = review.current;
      if (!r || r.fields.some((f) => !choices[f.key])) throw Error('请为每个冲突字段选择保留内容');
      const m = mergeWorkspace(r.base, r.local, r.current.data, choices);
      let d: Data;
      try {
        d = prepareWorkspace(parseBackup(m.data));
      } catch {
        throw Error('所选内容仍有日期或关联冲突，请核对对应云端记录，或先下载草稿备份。');
      }
      baseline.current = r.current;
      viewBase.current = r.current.data;
      current.current = d;
      setData(d);
      review.current = null;
      setSaveConflict(null);
      blocked.current = false;
      inFlight.current = null;
      pending.current = true;
      ++sequence.current;
      await persist();
    },
    [persist, stash],
  );
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
      if (review.current) {
        setSaveConflict(review.current);
        return Promise.resolve();
      }
      if (exclusive.current) return Promise.resolve();
      blocked.current = false;
      return working.current ? working.current.then(() => persist()) : persist();
    },
    hasUnsavedChanges: pending.current,
    isCloud: true,
    cloudUser: user,
    reloadCloud,
    changeDeadline,
    saveConflict,
    resolveSaveConflict,
    dismissSaveConflict: () => setSaveConflict(null),
  };
}
