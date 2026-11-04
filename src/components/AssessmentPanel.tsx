import { primaryPerson, linkedAssessmentView, linkedDailyView } from '../lib/person-links';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloudApi, queueCloudRecord, CloudError } from '../lib/cloud';
import {
  verifiedOwner,
  pendingRecords,
  finishSupersededRecord,
  signalOutbox,
} from '../lib/record-outbox';
import {
  assessmentCandidates,
  assessmentToday,
  checkFields,
  checkLabels,
  dailyKey,
  statusLabel,
  type Assessment,
  type CheckField,
  type CheckStatus,
  type DailyAssessment,
} from '../lib/assessments';
import {
  assessmentDrafts,
  readAllAssessments,
  retryAssessmentIntent,
  setAssessmentIntent,
  type AssessmentDraft,
  type AssessmentTarget,
} from '../lib/assessment-sync';
import { dateOK, isHistorical, type Data } from '../lib/model';
import { AssessmentGrants, type AssessmentAccess } from './AssessmentGrants';
import { AssessmentPersonPicker } from './AssessmentPersonPicker';
import { PersonAssessmentStats, ProjectAssessmentSummary } from './AssessmentStats';
import { ProjectSurface } from './ProjectThemes';
import { DateField } from './DateField';
import { Modal } from './Modal';
import './assessments.css';
const labels: Record<CheckField, string> = { attendance: '签到', photo: '拍照', cleaning: '卫生' };
const states = [
  { value: 'yes', glyph: '✓', label: '已完成' },
  { value: 'no', glyph: '×', label: '未完成' },
  { value: 'pending', glyph: '—', label: '未记录' },
] as const;
const mergeRecords = (old: Assessment[], added: Assessment[]) => {
  const map = new Map(old.map((r) => [r.id, r]));
  for (const r of added)
    if (!map.has(r.id) || map.get(r.id)!.version <= r.version) map.set(r.id, r);
  return [...map.values()];
};
type HistoryEvent = {
  id: string;
  actorName: string;
  createdAt: string;
  before: Assessment | null;
  after: Assessment;
};
export function AssessmentPanel({ data, isCloud }: { data: Data; isCloud: boolean }) {
  const [now, setNow] = useState(assessmentToday),
    [dates, setDates] = useState<Record<string, string>>({});
  const [project, setProject] = useState(''),
    [person, setPerson] = useState('');
  const [access, setAccess] = useState<AssessmentAccess | null>(null),
    [records, setRecords] = useState<Assessment[]>([]),
    [storedDrafts, setDrafts] = useState<AssessmentDraft[]>([]);
  const [error, setError] = useState('');
  const [slots, setSlots] = useState<Record<string, number>>({}),
    [reserved, setReserved] = useState<AssessmentTarget[]>([]),
    [expanded, setExpanded] = useState<string[]>([]);
  const [volatile, setVolatile] = useState<
    Record<string, Partial<Record<CheckField, CheckStatus>>>
  >({});
  const [history, setHistory] = useState<{
    name: string;
    sources: Assessment[];
    events: HistoryEvent[];
  } | null>(null);
  const sequence = useRef(0);
  const loadGuard = useRef<{ scope: string; again: boolean } | null>(null);
  const loadLatest = useRef<() => Promise<void>>(async () => {});
  const recordScope = useRef('');
  const owner = verifiedOwner(),
    ownerKey = owner ? owner.workspaceId + ':' + owner.id : '';
  const drafts = storedDrafts.filter(
    (d) => d.owner.id === owner?.id && d.owner.workspaceId === owner?.workspaceId,
  );
  const [verifiedScope, setVerifiedScope] = useState('');
  useEffect(() => {
    setHistory(null);
    setVolatile({});
    setReserved([]);
    setSlots({});
    setPerson('');
    setProject('');
    setReplacement(null);
    setOrders({});
    ordersRef.current = {};
    setSelectionPreviews({});
    selectionQueue.current = Promise.resolve();
    selectionVersions.current = {};
  }, [ownerKey]);
  type Selection = {
    projectId: string;
    projectName: string;
    date: string;
    index: number;
    oldId: string;
    nextId: string;
    order: (string | null)[];
  };
  const [replacement, setReplacement] = useState<Selection | null>(null);
  const [selectionPreviews, setSelectionPreviews] = useState<Record<string, Selection>>({});
  const [orders, setOrders] = useState<Record<string, (string | null)[]>>({});
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const selectionQueue = useRef(Promise.resolve());
  const selectionVersions = useRef<Record<string, number>>({});
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  useEffect(() => {
    const update = () => {
      const next = assessmentToday();
      if (next !== now) {
        setDates((old) =>
          Object.fromEntries(Object.entries(old).map(([id, d]) => [id, d === now ? next : d])),
        );
        setNow(next);
      }
    };
    const timer = setInterval(update, 30000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [now]);
  const refreshDrafts = useCallback(async () => {
    const scope = verifiedOwner();
    const rows = await assessmentDrafts(scope);
    if (scope?.id === verifiedOwner()?.id && scope?.workspaceId === verifiedOwner()?.workspaceId)
      setDrafts(rows);
  }, [ownerKey]);
  const load = useCallback(async () => {
    if (!isCloud) return;
    if (loadGuard.current?.scope === ownerKey) {
      loadGuard.current.again = true;
      return;
    }
    const run = { scope: ownerKey, again: false };
    loadGuard.current = run;
    const token = ++sequence.current;

    try {
      const permission = await cloudApi<AssessmentAccess>('/assessments/access');
      if (token !== sequence.current) return;
      setAccess(permission);
      if (!permission.allowed) {
        setRecords([]);
        setVerifiedScope(ownerKey);
        return;
      }
      const rows = await readAllAssessments(now);
      if (token === sequence.current) {
        const sameScope = recordScope.current === ownerKey;
        setRecords((old) => (sameScope ? mergeRecords(old, rows) : rows));
        recordScope.current = ownerKey;
        setVerifiedScope(ownerKey);
        setError('');
      }
    } catch (e) {
      if (token !== sequence.current) return;
      report(e);
      if (e instanceof CloudError && [401, 403].includes(e.status)) {
        setRecords([]);
        setAccess({ allowed: false, owner: false });
        setVerifiedScope(ownerKey);
      }
    } finally {
      if (loadGuard.current === run) {
        loadGuard.current = null;
        const live = verifiedOwner();
        if (run.again && run.scope === (live ? live.workspaceId + ':' + live.id : ''))
          setTimeout(() => {
            void loadLatest.current();
          }, 250);
      }
    }
  }, [isCloud, now, ownerKey, report]);
  loadLatest.current = load;
  useEffect(() => {
    if (!isCloud) return;
    void load();
    void refreshDrafts().catch(report);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void load();
      }, 120);
    };
    const local = () => {
      void refreshDrafts().catch(report);
    };
    const confirmed = (e: Event) => {
      const result = (e as CustomEvent).detail;
      const live = verifiedOwner();
      if (result.owner?.id !== live?.id || result.owner?.workspaceId !== live?.workspaceId) return;
      setRecords((old) => mergeRecords(old, result.records));
      local();
      refresh();
    };
    const undoPreview = (e: Event) => {
      const { key, values, owner } = (e as CustomEvent).detail;
      const current = verifiedOwner();
      if (owner?.id !== current?.id || owner?.workspaceId !== current?.workspaceId) return;
      setVolatile((old) => ({ ...old, [key]: values }));
    };
    window.addEventListener('chunmo-assessment-undo-preview', undoPreview);
    window.addEventListener('chunmo-assessments-changed', refresh);
    window.addEventListener('chunmo-assessment-drafts', local);
    window.addEventListener('chunmo-assessment-confirmed', confirmed);
    window.addEventListener('focus', refresh);
    const fallback = setInterval(refresh, 30000);
    return () => {
      ++sequence.current;
      loadGuard.current = null;
      clearTimeout(timer);
      clearInterval(fallback);
      window.removeEventListener('chunmo-assessment-undo-preview', undoPreview);
      window.removeEventListener('chunmo-assessments-changed', refresh);
      window.removeEventListener('chunmo-assessment-drafts', local);
      window.removeEventListener('chunmo-assessment-confirmed', confirmed);
      window.removeEventListener('focus', refresh);
    };
  }, [isCloud, load, refreshDrafts, report]);
  const confirmedRows = useMemo(
    () =>
      mergeRecords(
        records,
        drafts.flatMap((d) => d.target.sources),
      ),
    [records, drafts],
  );
  const statisticsRows = linkedAssessmentView(confirmedRows, data).filter(
    (r) => !data.people?.find((p) => p.id === r.personId)?.hiddenFromSelectors,
  );
  const daily = useMemo(
    () =>
      linkedDailyView(confirmedRows, data).filter(
        (r) => !data.people?.find((p) => p.id === r.personId)?.hiddenFromSelectors,
      ),
    [confirmedRows, data],
  );

  const people = (data.people ?? []).filter(
    (p) =>
      p.role === '施工人员' && p.active && !p.deleted && !p.identityLink && !p.hiddenFromSelectors,
  );
  const personNames = new Map([
    ...statisticsRows.map((r) => [r.personId, r.personName] as const),
    ...(data.people ?? [])
      .filter((p) => p.role === '施工人员' && !p.identityLink && !p.hiddenFromSelectors)
      .map((p) => [p.id, p.name] as const),
  ]);
  for (const p of data.people ?? [])
    if (p.hiddenFromSelectors || p.identityLink) personNames.delete(p.id);
  const projectNames = new Map([
    ...statisticsRows.map((r) => [r.projectId, r.projectName] as const),
    ...data.projects.map((p) => [p.id, p.name] as const),
  ]);
  const sites = [...projectNames].filter(
    ([id]) =>
      (!project || id === project) &&
      (project ||
        data.projects.some((p) => p.id === id && !isHistorical(p)) ||
        daily.some((r) => r.projectId === id && r.date === (dates[id] ?? now)) ||
        drafts.some((d) => d.target.projectId === id && d.target.date === (dates[id] ?? now))),
  );
  async function change(
    target: AssessmentTarget,
    changes: Partial<Record<CheckField, CheckStatus>>,
  ) {
    const key = dailyKey(target);
    setVolatile((old) => ({ ...old, [key]: { ...old[key], ...changes } }));
    try {
      await setAssessmentIntent(target, changes);
      await refreshDrafts();
      setVolatile((old) => {
        const values = { ...old[key] };
        for (const f of checkFields) if (values[f] === changes[f]) delete values[f];
        return { ...old, [key]: values };
      });
    } catch (e) {
      setError(
        '本地尚未可靠保存，请保留页面并重试：' + (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  async function showHistory(row: DailyAssessment) {
    const scope = ownerKey;
    try {
      const events = (
        await Promise.all(
          row.sources.map((r) =>
            cloudApi<{ events: HistoryEvent[] }>(
              `/assessments/${encodeURIComponent(r.id)}/history`,
            ),
          ),
        )
      ).flatMap((r) => r.events);
      if (scope !== verifiedOwner()?.workspaceId + ':' + verifiedOwner()?.id) return;
      setHistory({
        name: row.personName,
        sources: row.sources,
        events: events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    } catch (e) {
      report(e);
    }
  }
  async function retry(draft: AssessmentDraft) {
    try {
      const fresh = await readAllAssessments(now);
      setRecords(fresh);
      await retryAssessmentIntent(
        draft,
        fresh.filter((r) => dailyKey(r) === dailyKey(draft.target)),
      );
      await refreshDrafts();
    } catch (e) {
      report(e);
    }
  }
  function setRowOrder(action: Selection, id: string) {
    const key = JSON.stringify([action.date, action.projectId]);
    const order = [...action.order];
    selectionVersions.current[key] = (selectionVersions.current[key] ?? 0) + 1;
    order[action.index] = id || null;
    ordersRef.current = { ...ordersRef.current, [key]: order };
    setOrders(ordersRef.current);
  }
  async function choosePerson(action: Selection, confirmed = false) {
    const scope = ownerKey;
    const live = () => scope === verifiedOwner()?.workspaceId + ':' + verifiedOwner()?.id;
    const key = JSON.stringify([action.date, action.projectId]) + ':' + action.index;
    try {
      if (!live()) return;
      if (
        !action.oldId &&
        action.nextId &&
        !confirmedRows.some(
          (r) =>
            r.projectId === action.projectId &&
            r.date === action.date &&
            primaryPerson(data.people ?? [], r.personId) === action.nextId,
        )
      ) {
        const p = people.find((p) => p.id === action.nextId);
        if (!p) throw Error('请选择有效人员档案');
        const next: AssessmentTarget = {
          date: action.date,
          projectId: action.projectId,
          projectName: action.projectName,
          personId: p.id,
          personName: p.name,
          sources: [],
        };
        setRowOrder(action, p.id);
        setReserved((old) => [...old.filter((r) => dailyKey(r) !== dailyKey(next)), next]);
        await change(next, { attendance: 'pending', photo: 'pending', cleaning: 'pending' });
        return;
      }
      // Let the existing durable row queue finish before creating the inverse link.
      for (let i = 0; i < 30; i++) {
        const pending = (await assessmentDrafts()).find(
          (d) =>
            d.target.projectId === action.projectId &&
            d.target.date === action.date &&
            d.target.personId === action.oldId,
        );
        if (!pending) break;
        if (pending.blocked || !navigator.onLine || i === 29)
          throw Error('本行仍有待同步打卡，请先完成同步或核对冲突后再更换人员。');
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!live()) return;
      const fresh: Assessment[] = [];
      let cursor: string | null = null;
      do {
        const params: URLSearchParams = new URLSearchParams({
          from: action.date,
          to: action.date,
          projectId: action.projectId,
          ...(cursor ? { cursor } : {}),
        });
        const page: { records: Assessment[]; nextCursor: string | null } = await cloudApi<{
          records: Assessment[];
          nextCursor: string | null;
        }>('/assessments?' + params);
        fresh.push(...page.records);
        cursor = page.nextCursor;
      } while (cursor);
      if (scope !== verifiedOwner()?.workspaceId + ':' + verifiedOwner()?.id) return;
      const oldSources = fresh.filter(
        (r) =>
          r.projectId === action.projectId &&
          primaryPerson(data.people ?? [], r.personId) === action.oldId &&
          !r.withdrawn,
      );
      if (action.oldId === action.nextId) return;
      if (action.oldId && !oldSources.length)
        throw Error('该行人员已由其他操作更换，请核对当前记录后重新选择。');
      if (oldSources.length && !confirmed) {
        let recorded = oldSources.some((r) => checkFields.some((f) => r[f] !== 'pending'));
        if (!recorded) {
          const history = await Promise.all(
            oldSources.map((r) =>
              cloudApi<{ events: HistoryEvent[] }>(
                `/assessments/${encodeURIComponent(r.id)}/history`,
              ),
            ),
          );
          recorded = history.some((h) =>
            h.events.some((e) =>
              checkFields.some(
                (f) => e.after[f] !== 'pending' || (e.before && e.before[f] !== 'pending'),
              ),
            ),
          );
        }
        if (!live()) return;
        if (recorded) {
          setReplacement(action);
          return;
        }
      }
      const candidates = fresh.filter(
        (r) =>
          r.projectId === action.projectId &&
          primaryPerson(data.people ?? [], r.personId) === action.nextId,
      );
      if (action.nextId && candidates.some((r) => !r.withdrawn))
        throw Error('该师傅在此工地当天已有一行，请直接使用原行，不能重复选择。');
      // Restoring a prior person restores their own states; it never copies another person's grades.
      if (
        action.nextId &&
        !confirmed &&
        candidates.some((r) => checkFields.some((f) => r[f] !== 'pending'))
      ) {
        setReplacement(action);
        return;
      }
      const edits: any[] = oldSources.map((r) => ({
        date: r.date,
        projectId: r.projectId,
        personId: r.personId,
        tradeId: r.tradeId,
        version: r.version,
        changes: { withdrawn: true, correctionReason: '更换或暂时不选当天打卡人员' },
      }));
      if (action.nextId) {
        if (candidates.length)
          edits.push(
            ...candidates.map((r) => ({
              date: r.date,
              projectId: r.projectId,
              personId: r.personId,
              tradeId: r.tradeId,
              version: r.version,
              changes: { withdrawn: false, correctionReason: '确认恢复该人员自身当天记录' },
            })),
          );
        else
          edits.push({
            date: action.date,
            projectId: action.projectId,
            personId: action.nextId,
            tradeId: 'daily',
            version: 0,
            changes: { attendance: 'pending', photo: 'pending', cleaning: 'pending' },
          });
      }
      if (!edits.length) {
        setRowOrder(action, '');
        return;
      }
      if (!live()) return;
      const rejected = (await pendingRecords(verifiedOwner()!)).filter(
        (e) =>
          e.blocked &&
          e.path === '/assessments/batch' &&
          e.body?.edits?.some(
            (edit: any) =>
              edit.date === action.date &&
              edit.projectId === action.projectId &&
              ((edit.changes?.withdrawn === true &&
                primaryPerson(data.people ?? [], edit.personId) === action.oldId) ||
                (!action.oldId &&
                  edit.changes?.withdrawn === false &&
                  primaryPerson(data.people ?? [], edit.personId) === action.nextId)),
          ),
      );
      if (!live()) return;
      const queued = await queueCloudRecord('/assessments/batch', 'POST', {
        requestId: crypto.randomUUID(),
        confirmed: true,
        edits,
      });
      if (!live()) return;
      setSelectionPreviews((old) => ({ ...old, [key]: action }));
      setRowOrder(action, action.nextId);
      const result = await queued.completion;
      if (scope !== verifiedOwner()?.workspaceId + ':' + verifiedOwner()?.id) return;
      setRecords((old) => mergeRecords(old, result.records));
      setReserved((old) =>
        old.filter(
          (r) =>
            !(
              r.projectId === action.projectId &&
              r.date === action.date &&
              (r.personId === action.oldId || r.personId === action.nextId)
            ),
        ),
      );
      for (const entry of rejected) await finishSupersededRecord(entry.body.requestId);
      if (rejected.length) {
        const pending = await pendingRecords(verifiedOwner()!);
        const local = await assessmentDrafts();
        signalOutbox(
          pending.some((e) => e.blocked) || local.some((e) => e.blocked)
            ? '存在待处理冲突'
            : pending.length || local.length
              ? '本地已保存，正在上传'
              : '云端已保存',
        );
      }
      setReplacement(null);
    } catch (e) {
      if (!live()) return;
      report(e);
      setRowOrder(action, action.oldId);
    } finally {
      if (!live()) return;
      setSelectionPreviews((old) => {
        const next = { ...old };
        delete next[key];
        return next;
      });
    }
  }
  function selectPerson(action: Selection) {
    const key = JSON.stringify([action.date, action.projectId]);
    const revision = selectionVersions.current[key] ?? 0;
    selectionQueue.current = selectionQueue.current
      .catch(() => {})
      .then(() => {
        const order = ordersRef.current[key];
        const advanced = (selectionVersions.current[key] ?? 0) !== revision;
        return choosePerson(
          advanced && order
            ? { ...action, order: [...order], oldId: order[action.index] || '' }
            : action,
        );
      });
  }
  if (!isCloud)
    return (
      <section className="assessment-panel">
        <h2>师傅每日考核</h2>
        <p className="assessment-local">
          云端登录后可按工地记录每日考核，本地人员档案和原有数据保留。
        </p>
      </section>
    );
  const checking = !access || verifiedScope !== ownerKey;
  if (!checking && !access?.allowed)
    return (
      <section className="assessment-panel">
        <h2>师傅每日考核</h2>
        <p className="assessment-local">考核记录仅向负责人及其授权的记录人开放。</p>
      </section>
    );
  return (
    <section
      className={`assessment-panel daily-assessment${checking ? ' assessment-loading' : ''}`}
      aria-label="师傅每日考核"
      aria-busy={checking}
      inert={checking}
      data-loading-message={error || '正在读取考核记录…'}
    >
      <div className="section-heading">
        <h2>师傅每日考核</h2>
        <div className="toolbar">
          <AssessmentGrants
            access={access ?? { allowed: false, owner: false }}
            onChanged={() => {
              void load();
            }}
            onError={report}
          />
        </div>
      </div>
      <div className="assessment-filters">
        <label>
          工地
          <select
            aria-label="考核工地"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">全部在施工地</option>
            {[...projectNames].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          师傅姓名
          <select
            aria-label="师傅跨工地查询"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          >
            <option value="">选择师傅查看跨工地历史</option>
            {[...personNames].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
                {[...personNames.values()].filter((other) => other === name).length > 1
                  ? ' · ' +
                    (data.people
                      ?.find((p) => p.id === id)
                      ?.notes.trim()
                      .slice(0, 16) ||
                      data.people?.find((p) => p.id === id)?.trade ||
                      '同名档案')
                  : ''}
                {data.people?.find((p) => p.id === id)?.deleted ? '（已移出档案）' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="assessment-hint">
        按北京时间打卡，可补录历史日期。✓ 已完成　× 未完成　— 未记录（不计失败）。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="assessment-sync-status">统计以云端确认记录为准。</p>
      {person && (
        <PersonAssessmentStats
          personId={person}
          name={personNames.get(person) || '历史师傅'}
          records={statisticsRows}
        />
      )}
      <div className="assessment-sites">
        {sites.map(([projectId, projectName]) => {
          const date = dates[projectId] ?? now;
          const validDate = dateOK(date) && date <= now;
          const candidates = assessmentCandidates(data, date);
          const selected = daily
            .filter((r) => r.projectId === projectId && r.date === date)
            .sort(
              (a, b) =>
                [...a.sources]
                  .map((r) => r.createdAt)
                  .sort()[0]
                  .localeCompare([...b.sources].map((r) => r.createdAt).sort()[0]) ||
                a.personId.localeCompare(b.personId),
            );
          const local = drafts.filter(
            (d) => d.target.projectId === projectId && d.target.date === date,
          );
          const reservedHere = reserved.filter(
            (r) =>
              r.projectId === projectId &&
              r.date === date &&
              !confirmedRows.some((saved) => dailyKey(saved) === dailyKey(r)),
          );
          const detected = [
            ...new Set([
              ...selected.map((r) => r.personId),
              ...local.map((d) => d.target.personId),
              ...reservedHere.map((r) => r.personId),
            ]),
          ];
          const slotKey = JSON.stringify([date, projectId]);
          const previews = Object.values(selectionPreviews).filter(
            (r) => r.projectId === projectId && r.date === date,
          );
          const ids = [
            ...new Set([
              ...detected.filter((id) => !previews.some((p) => p.oldId === id)),
              ...previews.map((p) => p.nextId).filter(Boolean),
            ]),
          ];
          const chosen = (orders[slotKey] ?? detected).map((id) =>
            id && ids.includes(id) ? id : null,
          );
          for (const id of ids)
            if (!chosen.includes(id)) {
              const empty = chosen.indexOf(null);
              if (empty >= 0) chosen[empty] = id;
              else chosen.push(id);
            }
          const count = Math.max(chosen.length, slots[slotKey] ?? 3);
          const preferred = new Set(
            candidates.filter((r) => r.projectId === projectId).map((r) => r.personId),
          );
          const canCreate = validDate && data.projects.some((p) => p.id === projectId);
          return (
            <div className="assessment-site-pair" key={projectId} data-project-id={projectId}>
              <ProjectSurface projectId={projectId} className="assessment-site-card">
                <header>
                  <div>
                    <h3>{projectName}</h3>
                    <DateField
                      label={`${projectName}打卡日期`}
                      value={date}
                      max={now}
                      required
                      onChange={(value) => setDates((old) => ({ ...old, [projectId]: value }))}
                    />
                  </div>
                  <button
                    type="button"
                    aria-expanded={expanded.includes(projectId)}
                    onClick={() =>
                      setExpanded((old) =>
                        old.includes(projectId)
                          ? old.filter((id) => id !== projectId)
                          : [...old, projectId],
                      )
                    }
                  >
                    数据小结
                  </button>
                </header>
                {!validDate && (
                  <p role="alert" className="error">
                    不能记录未来日期，请选择今天或历史日期。
                  </p>
                )}
                <div role="table" aria-label={`${projectName}每日打卡`}>
                  <div className="assessment-four-column assessment-row-head" role="row">
                    <span role="columnheader">姓名</span>
                    {checkFields.map((f) => (
                      <span role="columnheader" key={f}>
                        {labels[f]}
                      </span>
                    ))}
                  </div>
                  {Array.from({ length: count }, (_, index) => {
                    const personId = chosen[index] || undefined;
                    const selecting = previews.some((p) => p.index === index);
                    const saved = selected.find((r) => r.personId === personId);
                    const draft = local.find((d) => d.target.personId === personId);
                    const target =
                      draft?.target ??
                      (saved
                        ? {
                            date,
                            personId: saved.personId,
                            projectId,
                            personName: saved.personName,
                            projectName,
                            sources: saved.sources,
                          }
                        : reservedHere.find((r) => r.personId === personId));
                    const rowKey = target ? dailyKey(target) : '';
                    const values = {
                      attendance: saved?.attendance ?? 'pending',
                      photo: saved?.photo ?? 'pending',
                      cleaning: saved?.cleaning ?? 'pending',
                      ...Object.fromEntries(
                        checkFields
                          .filter((f) => draft?.fields[f])
                          .map((f) => [f, draft!.fields[f]!.value]),
                      ),
                      ...volatile[rowKey],
                    } as Record<CheckField, CheckStatus>;
                    const name =
                      data.people?.find((p) => p.id === personId)?.name || target?.personName || '';
                    return (
                      <div
                        key={personId || 'empty:' + index}
                        className={`assessment-day-row ${personId ? '' : 'empty'} ${draft?.blocked ? 'needs-review' : ''}`}
                        data-person-id={personId || undefined}
                      >
                        <div className="assessment-four-column" role="row">
                          <div className="assessment-person-cell" role="cell">
                            <AssessmentPersonPicker
                              people={people}
                              assigned={preferred}
                              excluded={
                                new Set(
                                  chosen
                                    .filter((id): id is string => !!id && id !== personId)
                                    .map((id) => primaryPerson(data.people ?? [], id)),
                                )
                              }
                              value={personId || ''}
                              selectedName={name}
                              label={`${projectName}第${index + 1}行选择师傅`}
                              disabled={!canCreate}
                              onSelect={(id) =>
                                selectPerson({
                                  projectId,
                                  projectName,
                                  date,
                                  index,
                                  oldId: personId || '',
                                  nextId: id,
                                  order: chosen,
                                })
                              }
                            />
                          </div>
                          {checkFields.map((f) => (
                            <div
                              className="assessment-checks"
                              role="cell"
                              key={f}
                              aria-label={`${name || '未选师傅'}${labels[f]}`}
                            >
                              <select
                                className={`assessment-status-select status-${values[f]}`}
                                aria-label={`${name || '未选师傅'}${labels[f]}`}
                                title={`${labels[f]}：${states.find((s) => s.value === values[f])?.label}`}
                                value={values[f]}
                                disabled={!target || !validDate || selecting}
                                onChange={(e) =>
                                  target &&
                                  void change(target, { [f]: e.target.value as CheckStatus })
                                }
                              >
                                {states.map((s) => (
                                  <option key={s.value} value={s.value} aria-label={s.label}>
                                    {s.glyph}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                        {saved && saved.sources.length > 1 ? (
                          <details className="assessment-legacy-warning">
                            <summary>
                              {saved.differences.length
                                ? '同日来源有差异（不计失败）'
                                : '同日来源已一致（历史保留）'}
                            </summary>
                            {saved.sources.map((r) => (
                              <p key={r.id}>
                                {r.tradeName}：
                                {checkFields
                                  .map((f) => `${labels[f]} ${statusLabel(f, r[f])}`)
                                  .join(' · ')}
                              </p>
                            ))}
                            <p>修改某一项会同步这一项到当日来源，并逐条保留修改历史。</p>
                          </details>
                        ) : null}
                        {draft?.blocked && (
                          <div className="assessment-conflict" role="alert">
                            <p>{draft.blocked.message}；本地选择仍保留。</p>
                            <p>
                              云端：
                              {checkFields
                                .map(
                                  (f) => `${labels[f]} ${statusLabel(f, saved?.[f] ?? 'pending')}`,
                                )
                                .join(' · ')}
                              <br />
                              本地待提交：
                              {checkFields
                                .filter((f) => draft.fields[f])
                                .map(
                                  (f) => `${labels[f]} ${statusLabel(f, draft.fields[f]!.value)}`,
                                )
                                .join(' · ')}
                            </p>
                            <button type="button" onClick={() => void retry(draft)}>
                              核对后按最新版本重试本行
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <footer>
                  <button
                    type="button"
                    disabled={!canCreate}
                    onClick={() => setSlots((old) => ({ ...old, [slotKey]: count + 1 }))}
                  >
                    ＋ 添加人员
                  </button>
                </footer>
              </ProjectSurface>
              {expanded.includes(projectId) && (
                <ProjectAssessmentSummary
                  projectId={projectId}
                  projectName={projectName}
                  records={statisticsRows}
                  onHistory={(id) => {
                    const rows = linkedDailyView(
                      confirmedRows.map((r) => ({ ...r, withdrawn: false })),
                      data,
                    ).filter((r) => r.projectId === projectId && r.personId === id);
                    if (rows.length)
                      void showHistory({ ...rows[0], sources: rows.flatMap((r) => r.sources) });
                  }}
                  onClose={() => setExpanded((old) => old.filter((id) => id !== projectId))}
                />
              )}
            </div>
          );
        })}
      </div>
      {!sites.length && (
        <p className="assessment-empty">暂无符合条件的工地。可从筛选中选择历史工地。</p>
      )}
      {replacement && (
        <Modal title="确认更换打卡人员" onClose={() => setReplacement(null)}>
          <div className="modal-body">
            <p>已有打卡记录，是否确认更换打卡人员？</p>
            <p>原人员的打卡及历史保留，不会转记给另一位师傅。选择原人员时恢复其自身记录。</p>
          </div>
          <footer className="modal-foot">
            <button onClick={() => setReplacement(null)}>取消</button>
            <button
              className="primary"
              onClick={() => {
                const action = replacement;
                setReplacement(null);
                selectionQueue.current = selectionQueue.current
                  .catch(() => {})
                  .then(() => choosePerson(action, true));
              }}
            >
              确认
            </button>
          </footer>
        </Modal>
      )}
      {history && (
        <Modal title={`考核历史 · ${history.name}`} onClose={() => setHistory(null)}>
          <div className="modal-body assessment-history">
            {history.sources.map((r) => (
              <p key={r.id}>
                {r.projectName} · 打卡日 {r.date} · {r.tradeName}
                <br />
                实际首次录入：{r.createdName} ·{' '}
                {new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              </p>
            ))}
            {history.events.map((e) => (
              <article key={e.id}>
                <strong>
                  {e.actorName} ·{' '}
                  {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </strong>
                {e.before?.withdrawn !== e.after.withdrawn && (
                  <p>
                    {e.after.withdrawn ? '已撤回当天人员' : '恢复人员自身记录'} ·{' '}
                    {e.after.correctionReason}
                  </p>
                )}
                <p>
                  {checkFields
                    .map(
                      (f) =>
                        `${checkLabels[f]}：${e.before ? statusLabel(f, e.before[f]) : '未保存'} → ${statusLabel(f, e.after[f])}`,
                    )
                    .join('；')}
                </p>
              </article>
            ))}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setHistory(null)}>关闭</button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
