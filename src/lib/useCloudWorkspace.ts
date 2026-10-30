import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyData, parseBackup, prepareWorkspace, type Data } from './model';
import { canonical, emptyHistory, validateHistory } from './history';
import { cloudApi, cloudSession, CloudError, type CloudState, type CloudUser } from './cloud';
import {
  clearCloudDraft,
  claimDraftTab,
  recoverCloudDraft,
  cloudDraftRecoveryPackage,
  hasCloudDraftArchive,
  retainCloudDraftSnapshot,
  writeCloudDraft,
  type CloudDraft,
} from './cloud-drafts';
import { mergeWorkspace, type MergeChoices, type WorkspaceConflict } from './workspace-merge';
import type { SaveOptions } from './storage';
import {
  planWorkspaceSave,
  holdsForFailure,
  withholdResources,
  releaseCorrectedHolds,
  pendingSaveMessage,
  resourceKey,
  resourceValue,
  reconcileWorkspaceView,
  type SaveHold,
} from './workspace-save-plan';
export type SaveConflict = {
  kind?: 'conflict' | 'validation';
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
    [draftRecoveryNotice, setDraftRecoveryNotice] = useState(''),
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
    holds = useRef<SaveHold[]>([]),
    recovering = useRef(false),
    recoveryMessage = useRef(''),
    retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    retryCount = useRef(0),
    wake = useRef<() => Promise<void>>(() => Promise.resolve()),
    initialized = useRef(false),
    alive = useRef(true);
  const showReview = useCallback(
    (
      s: CloudState,
      fields: WorkspaceConflict[],
      message?: string,
      open = true,
      kind: SaveConflict['kind'] = 'conflict',
    ) => {
      const value = { base: viewBase.current, local: current.current, current: s, fields, kind };
      review.current = value;
      setSaveConflict((previous) => (open || previous ? value : null));
      baseline.current = s;
      setSavedData(s.data);
      setHistory(s.history);
      pending.current = true;
      setStatus(
        kind === 'validation' ? '部分未保存' : recovering.current ? '草稿待恢复' : '保存冲突',
      );
      setError(message || '相同字段已被修改，未覆盖云端。草稿已自动保留，请核对冲突内容。');
    },
    [],
  );
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
      ...(holds.current.length ? { holds: holds.current } : {}),
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
    if (
      !initialized.current ||
      interacting() ||
      working.current ||
      inFlight.current ||
      blocked.current
    ) {
      remote.current = true;
      return;
    }
    const seq = sequence.current,
      s = validState(await cloudApi<CloudState>('/workspace'));
    if (
      working.current ||
      inFlight.current ||
      blocked.current ||
      seq !== sequence.current ||
      interacting()
    ) {
      remote.current = true;
      return;
    }
    remote.current = false;
    if (pending.current) {
      baseline.current = s;
      setSavedData(s.data);
      setHistory(s.history);
      const next = reconcileWorkspaceView(viewBase.current, current.current, s.data);
      viewBase.current = next.base;
      current.current = next.data;
      setData(next.data);
      void wake.current();
    } else apply(s);
  }, [apply]);
  const persist = useCallback((): Promise<void> => {
    if (working.current) return working.current;
    clearTimeout(retryTimer.current);
    const run = async () => {
      while (alive.current && pending.current && !blocked.current) {
        let created = false,
          dispatched = false;
        try {
          if (!inFlight.current) {
            const s = baseline.current!;
            const plan = planWorkspaceSave(
              viewBase.current,
              current.current,
              s.data,
              holds.current,
            );
            holds.current = plan.holds;
            if (plan.conflicts.length) {
              const first = !review.current;
              showReview(s, plan.conflicts, undefined, first && !recovering.current);
            } else if (review.current?.kind !== 'validation' && review.current) {
              review.current = null;
              setSaveConflict(null);
            }
            if (canonical(plan.data) === canonical(s.data)) {
              pending.current = holds.current.length > 0;
              if (pending.current) {
                await stash();
                setStatus(
                  review.current && review.current.kind !== 'validation'
                    ? recovering.current
                      ? '草稿待恢复'
                      : '保存冲突'
                    : '部分未保存',
                );
                setError(
                  recoveryMessage.current +
                    pendingSaveMessage(holds.current, current.current, viewBase.current),
                );
              } else {
                if (!interacting()) apply(s);
                else remote.current = true;
                await clearDraft();
                retryCount.current = 0;
                recovering.current = false;
                recoveryMessage.current = '';
                setStatus('已保存');
                setError('');
              }
              return;
            }
            const d = prepareWorkspace(parseBackup(plan.data));
            inFlight.current = {
              // Acknowledgement excludes withheld intent; it must remain in the durable draft.
              view: plan.view,
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
          inFlight.current = null;
          setSavedData(s.data);
          setHistory(s.history);
          const next = reconcileWorkspaceView(sent.view, current.current, s.data);
          if (!interacting()) {
            current.current = next.data;
            viewBase.current = next.base;
            setData(next.data);
          } else {
            viewBase.current = sent.view;
            remote.current = true;
          }
          retryCount.current = 0;
          await stash();
        } catch (e) {
          // A journal failure before a new request was dispatched is a known non-submission.
          // Retain older ambiguous requests, but do not later replay a never-sent stale edit.
          if (created && !dispatched) inFlight.current = null;
          // Transport failures, timeouts and temporary throttling keep the exact receipt.
          const sent = inFlight.current;
          const definitive =
            e instanceof CloudError &&
            e.status >= 400 &&
            e.status < 500 &&
            ![408, 425, 429].includes(e.status);
          if (definitive) inFlight.current = null;
          if (e instanceof CloudError && e.status === 409 && e.details?.current) {
            const s = validState(e.details.current);
            baseline.current = s;
            setSavedData(s.data);
            setHistory(s.history);
            if (!interacting()) {
              const next = reconcileWorkspaceView(viewBase.current, current.current, s.data);
              viewBase.current = next.base;
              current.current = next.data;
              setData(next.data);
            } else remote.current = true;
            const plan = planWorkspaceSave(
              viewBase.current,
              current.current,
              s.data,
              holds.current,
            );
            holds.current = plan.holds;
            if (plan.conflicts.length)
              showReview(s, plan.conflicts, e.message, !review.current && !recovering.current);
            else if (sent) {
              const failed = holdsForFailure(sent.body.base, sent.body.data, e.message);
              holds.current = [
                ...new Map([...holds.current, ...failed].map((x) => [resourceKey(x), x])).values(),
              ];
            }
          } else {
            blocked.current =
              e instanceof CloudError &&
              (e.status === 401 ||
                (e.status === 403 && /登录|会话|来源|CSRF|基线|配置/.test(e.message)));
            if (!blocked.current && sent && definitive && e instanceof CloudError) {
              const details = e.details?.issues
                ?.map((x) => `${x.path.join('.')}：${x.message}`)
                .join('；');
              const reason =
                e.message +
                (details
                  ? `（${details}）`
                  : e.status === 400
                    ? '，请核对相关字段及前后端版本'
                    : '');
              const failed = holdsForFailure(
                sent.body.base,
                sent.body.data,
                reason,
                e.details?.issues,
              );
              holds.current = [
                ...new Map([...holds.current, ...failed].map((x) => [resourceKey(x), x])).values(),
              ];
              if (!failed.length) blocked.current = true;
            }
            setStatus(e instanceof CloudError && e.status === 409 ? '保存冲突' : '保存失败');
            setError(
              `${recoveryMessage.current}${e instanceof Error ? e.message : String(e)}。未丢弃草稿，正在保留并核对待提交内容；也可下载紧急备份。`,
            );
          }
          try {
            await stash();
          } catch {
            setError(
              '浏览器无法保留草稿（存储受限或空间不足）。草稿仍在当前页面；请立即下载紧急备份，暂勿关闭页面。',
            );
          }
          if (!blocked.current && definitive && holds.current.length) continue;
          if (!blocked.current && alive.current) {
            const delay = Math.min(30000, 1000 * 2 ** Math.min(retryCount.current++, 5));
            retryTimer.current = setTimeout(() => void wake.current(), delay);
          }
          return;
        }
      }
    };
    working.current = run().finally(() => {
      working.current = null;
    });
    return working.current;
  }, [apply, clearDraft, showReview, stash]);
  wake.current = persist;
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    initialized.current = false;
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
            const loaded = await recoverCloudDraft(u.workspaceId, u.id, lease.id);
            if (loaded.archived) {
              lease.release();
              sessionStorage.setItem('chunmo-cloud-draft-tab', crypto.randomUUID());
              const replacement = await claimDraftTab();
              if (!active) {
                replacement.release();
                return;
              }
              releaseTab = replacement.release;
              tab.current = replacement.id;
              setDraftRecoveryNotice(
                '旧草稿结构需要核对，原始内容和恢复副本均已保留；当前云端数据仍可正常使用。',
              );
            }
            return loaded.draft;
          })(),
        ]);
        if (!active) return;
        apply(s);
        void hasCloudDraftArchive(u.workspaceId, u.id)
          .then((exists) => {
            if (active && exists)
              setDraftRecoveryNotice(
                '旧草稿结构需要核对，原始内容和恢复副本均已保留；当前云端数据仍可正常使用。',
              );
          })
          .catch(() => {});
        if (draft) {
          baseline.current = s;
          // An ambiguous receipt must replay against its original view. Otherwise advance
          // untouched fields immediately, including while a genuine conflict stays pending.
          const next = draft.inFlight
            ? { base: draft.mergeBase, data: draft.data }
            : reconcileWorkspaceView(draft.mergeBase, draft.data, s.data);
          viewBase.current = next.base;
          current.current = next.data;
          inFlight.current = draft.inFlight;
          holds.current = draft.holds ?? [];
          setData(next.data);
          pending.current = true;
          blocked.current = false;
          recovering.current = true;
          recoveryMessage.current = '已恢复本账号的未提交草稿，正在自动核对和续传；';
          setStatus('草稿待恢复');
          setError(recoveryMessage.current + '真正冲突的内容保留待核对，其他记录不受影响。');
        }
        initialized.current = true;
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
        if (draft) void wake.current();
      })
      .catch((e) => {
        if (active) {
          setStatus('读取失败');
          setError(String(e));
        }
      });
    const deferred = setInterval(() => {
      if (
        remote.current &&
        !working.current &&
        !inFlight.current &&
        !blocked.current &&
        !interacting()
      )
        void refresh().catch((e) => setError(String(e)));
    }, 1000);
    const resume = () => {
      if (!initialized.current) return;
      if (pending.current && !blocked.current) void wake.current();
      else if (!blocked.current) void refresh().catch((e) => setError(String(e)));
    };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      active = false;
      alive.current = false;
      initialized.current = false;
      releaseTab();
      clearInterval(deferred);
      clearTimeout(retryTimer.current);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      events?.close();
      window.removeEventListener('chunmo-profile-updated', profileUpdated);
    };
  }, [enabled, initialUser, apply, refresh]);
  const update = useCallback(
    (fn: (d: Data) => Data, options?: SaveOptions) => {
      if (!ready) return;
      if (exclusive.current) throw Error('请等待当前恢复或期限变更完成，再继续编辑');
      if (blocked.current)
        throw Error('当前登录或保存基线不可用，请重新登录或核对云端；草稿已保留');
      if (options?.history || options?.source)
        throw Error('云空间请使用云端账号中的预览导入流程，不能覆盖整个空间');
      const d = prepareWorkspace(parseBackup(fn(current.current)));
      holds.current = releaseCorrectedHolds(current.current, d, holds.current);
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
        await persist();
        return;
      }
      if (holds.current.length) {
        const fields = holds.current.map((item) => {
          const id = item.collection === 'workspace' ? '' : item.id;
          const field =
            item.collection === 'workspace' ? item.id : item.id === '$order' ? 'order' : '$record';
          return {
            collection: item.collection,
            id,
            field,
            key: JSON.stringify([item.collection, id, field]),
            base: resourceValue(viewBase.current, item),
            local: resourceValue(current.current, item),
            remote: resourceValue(s.data, item),
          };
        });
        showReview(
          s,
          fields,
          '请修正失败记录，或明确选择采用云端内容；选择前会保留完整原草稿恢复副本。其他记录不受影响。',
          true,
          'validation',
        );
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
      const s = baseline.current!;
      const u = profile.current!;
      await stash();
      await retainCloudDraftSnapshot(u.workspaceId, u.id, tab.current);
      const selected =
        r.kind === 'validation'
          ? r.fields
              .filter((f) => choices[f.key] === 'remote')
              .map((f) => ({
                collection: f.collection as SaveHold['collection'],
                id: f.collection === 'workspace' ? f.field : f.id,
              }))
          : [];
      const local = withholdResources(current.current, s.data, selected);
      const m = mergeWorkspace(r.base, local, s.data, choices);
      if (m.conflicts.length) {
        showReview(s, m.conflicts);
        await stash();
        throw Error('云端又有相关修改，请核对新增冲突；全部草稿仍保留。');
      }
      let d: Data;
      try {
        d = prepareWorkspace(parseBackup(m.data));
      } catch {
        throw Error('所选内容仍有日期或关联冲突，请核对对应云端记录，或先下载草稿备份。');
      }
      holds.current =
        r.kind === 'validation' ? [] : holds.current.filter((x) => x.kind === 'validation');
      baseline.current = s;
      viewBase.current = withholdResources(s.data, viewBase.current, holds.current);
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
    [persist, showReview, stash],
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
    draftRecoveryNotice,
    draftRecoveryPackage: async () => {
      const u = profile.current;
      if (!u) throw Error('请先登录原草稿所属账号');
      await journal.current;
      return cloudDraftRecoveryPackage(u.workspaceId, u.id);
    },
    update,
    restoreVersion,
    retry: () => {
      if (review.current && review.current.kind !== 'validation') {
        setSaveConflict(review.current);
        return Promise.resolve();
      }
      if (exclusive.current) return Promise.resolve();
      review.current = null;
      setSaveConflict(null);
      blocked.current = false;
      holds.current = holds.current.filter((x) => x.kind === 'conflict');
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
