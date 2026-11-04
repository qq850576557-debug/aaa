import { primaryPerson, linkedAssessmentView, linkedDailyView } from '../lib/person-links';
import { Check, X, Minus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloudApi, queueCloudRecord, CloudError } from '../lib/cloud';
import { verifiedOwner, pendingRecords, finishSupersededRecord } from '../lib/record-outbox';
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
  }, [ownerKey]);
  const [correcting, setCorrecting] = useState<DailyAssessment | null>(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
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
  async function correctRow(replacement?: string) {
    if (!correcting || correctionBusy) return;
    setCorrectionBusy(true);
    try {
      const edits = correcting.sources.map((r) => ({
        date: r.date,
        personId: r.personId,
        projectId: r.projectId,
        tradeId: r.tradeId,
        version: r.version,
        changes: {
          withdrawn: true,
          correctionReason: replacement ? '误选人员，另行选择师傅' : '误选人员，移除当天行',
        },
      }));
      const pending = await pendingRecords(verifiedOwner()!);
      const sameCorrection = (body: any) =>
        body?.edits?.length === edits.length &&
        edits.every((e) =>
          body.edits.some(
            (x: any) =>
              x.date === e.date &&
              x.personId === e.personId &&
              x.projectId === e.projectId &&
              x.tradeId === e.tradeId &&
              x.changes?.withdrawn === true,
          ),
        );
      const previous = pending.find(
        (e) => e.path === '/assessments/batch' && !e.blocked && sameCorrection(e.body),
      );
      const queued = await queueCloudRecord(
        '/assessments/batch',
        'POST',
        previous?.body ?? { requestId: crypto.randomUUID(), confirmed: true, edits },
      );
      const result = await queued.completion;
      setRecords((old) => mergeRecords(old, result.records));
      setReserved((old) => old.filter((r) => dailyKey(r) !== dailyKey(correcting)));
      if (replacement) {
        const p = people.find((p) => p.id === replacement)!;
        await change(
          {
            date: correcting.date,
            projectId: correcting.projectId,
            personId: p.id,
            personName: p.name,
            projectName: correcting.projectName,
            sources: [],
          },
          { attendance: 'pending', photo: 'pending', cleaning: 'pending' },
        );
      }
      for (const entry of pending.filter((e) => e.blocked && sameCorrection(e.body)))
        await finishSupersededRecord(entry.body.requestId);
      setCorrecting(null);
    } catch (e) {
      if (e instanceof CloudError && e.status === 409) {
        const latest = await readAllAssessments(now);
        setRecords(latest);
        setCorrecting(
          linkedDailyView(latest, data).find((r) => dailyKey(r) === dailyKey(correcting)) ?? null,
        );
      }
      report(e);
    } finally {
      setCorrectionBusy(false);
    }
  }
  function exportPending() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ savedAt: new Date().toISOString(), drafts }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = '春茉待同步考核副本.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  if (!access || verifiedScope !== ownerKey)
    return (
      <section className="assessment-panel">
        <h2>师傅每日考核</h2>
        <p role="status">{error || '正在检查考核权限…'}</p>
      </section>
    );
  if (!access.allowed)
    return (
      <section className="assessment-panel">
        <h2>师傅每日考核</h2>
        <p className="assessment-local">考核记录仅向负责人及其授权的记录人开放。</p>
      </section>
    );
  return (
    <section className="assessment-panel daily-assessment" aria-label="师傅每日考核">
      <div className="section-heading">
        <h2>师傅每日考核</h2>
        <div className="toolbar">
          <AssessmentGrants
            access={access}
            onChanged={() => {
              void load();
            }}
            onError={report}
          />
          {drafts.length > 0 && <button onClick={exportPending}>导出待同步副本</button>}
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
      {
        <p className="assessment-sync-status" role="status">
          {!drafts.length
            ? '统计以云端确认记录为准。'
            : drafts.some((d) => d.blocked)
              ? '存在待核对考核，完整本地选择已保留。'
              : '本地已保存，后台同步中。'}{' '}
        </p>
      }
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
          const withdrawn = confirmedRows.filter(
            (r) => r.withdrawn && r.projectId === projectId && r.date === date,
          );
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
          const reservedHere = reserved.filter((r) => r.projectId === projectId && r.date === date);
          const chosen = [
            ...new Set([
              ...selected.map((r) => r.personId),
              ...local.map((d) => d.target.personId),
              ...reservedHere.map((r) => r.personId),
            ]),
          ];
          const slotKey = JSON.stringify([date, projectId]);
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
                    const personId = chosen[index];
                    const saved = selected.find((r) => r.personId === personId);
                    const draft = local.find((d) => d.target.personId === personId);
                    const target =
                      draft?.target ??
                      (saved
                        ? {
                            date,
                            personId,
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
                            {personId ? (
                              <>
                                <button
                                  type="button"
                                  className="assessment-person-name"
                                  title="重新选择师傅（保留原始历史）"
                                  disabled={!saved || !!draft}
                                  onClick={() => saved && setCorrecting(saved)}
                                >
                                  {name} ⌄
                                </button>
                                {saved && (
                                  <button
                                    className="assessment-remove-empty"
                                    disabled={!!draft}
                                    aria-label={`移除${name}当天打卡`}
                                    onClick={() => setCorrecting(saved)}
                                  >
                                    ×
                                  </button>
                                )}
                                {saved && (
                                  <button
                                    className="assessment-history-link"
                                    aria-label={`查看${name}打卡历史`}
                                    onClick={() => void showHistory(saved)}
                                  >
                                    历史
                                  </button>
                                )}
                                <small>
                                  {draft?.blocked
                                    ? '待核对'
                                    : Object.keys(volatile[rowKey] ?? {}).length
                                      ? '正在保存本地'
                                      : draft
                                        ? '本地已保存·待同步'
                                        : '已同步'}
                                  {saved && (
                                    <span
                                      title={`实际录入：${saved.createdName} ${new Date(saved.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`}
                                    >
                                      {' '}
                                      · {saved.updatedName}
                                    </span>
                                  )}
                                </small>
                              </>
                            ) : (
                              <div className="assessment-empty-person">
                                <AssessmentPersonPicker
                                  people={people}
                                  assigned={preferred}
                                  excluded={
                                    new Set(
                                      chosen.map((id) => primaryPerson(data.people ?? [], id)),
                                    )
                                  }
                                  label={`${projectName}第${index + 1}行选择师傅`}
                                  disabled={!canCreate}
                                  onSelect={(id) => {
                                    const p = people.find((p) => p.id === id)!;
                                    const next: AssessmentTarget = {
                                      date,
                                      projectId,
                                      personId: id,
                                      personName: p.name,
                                      projectName,
                                      sources: [],
                                    };
                                    const oldSources = withdrawn.filter((r) => r.personId === id);
                                    if (oldSources.length) {
                                      void queueCloudRecord('/assessments/batch', 'POST', {
                                        requestId: crypto.randomUUID(),
                                        confirmed: true,
                                        edits: oldSources.map((r) => ({
                                          date: r.date,
                                          personId: r.personId,
                                          projectId: r.projectId,
                                          tradeId: r.tradeId,
                                          version: r.version,
                                          changes: {
                                            withdrawn: false,
                                            correctionReason: '确认恢复当天人员',
                                          },
                                        })),
                                      })
                                        .then((q) => q.completion)
                                        .then((result) =>
                                          setRecords((old) => mergeRecords(old, result.records)),
                                        )
                                        .catch(report);
                                      return;
                                    }
                                    setReserved((old) => [...old, next]);
                                    void change(next, {
                                      attendance: 'pending',
                                      photo: 'pending',
                                      cleaning: 'pending',
                                    });
                                  }}
                                />
                                <button
                                  type="button"
                                  className="assessment-remove-empty"
                                  aria-label={`移除${projectName}第${index + 1}个空白行`}
                                  onClick={() =>
                                    setSlots((old) => ({ ...old, [slotKey]: count - 1 }))
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            )}
                          </div>
                          {checkFields.map((f) => (
                            <div
                              className="assessment-checks"
                              role="cell"
                              key={f}
                              aria-label={`${name || '未选师傅'}${labels[f]}`}
                            >
                              {states.map((s) => (
                                <button
                                  type="button"
                                  key={s.value}
                                  className={`assessment-check check-${s.value}`}
                                  disabled={!target || !validDate}
                                  aria-label={`${name || '未选师傅'}${labels[f]}${s.label}`}
                                  aria-pressed={!!target && values[f] === s.value}
                                  title={s.label}
                                  onClick={() => {
                                    if (
                                      target &&
                                      (values[f] !== s.value || saved?.differences.includes(f))
                                    )
                                      void change(target, { [f]: s.value });
                                  }}
                                >
                                  {s.value === 'yes' ? (
                                    <Check size={15} strokeWidth={3} />
                                  ) : s.value === 'no' ? (
                                    <X size={15} strokeWidth={3} />
                                  ) : (
                                    <Minus size={15} />
                                  )}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                        {saved?.differences.length ? (
                          <details className="assessment-legacy-warning">
                            <summary>同日旧工种记录存在差异，未计为失败；查看来源</summary>
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
                {!!withdrawn.length && (
                  <details className="assessment-source-detail">
                    <summary>已撤回的当天来源（{withdrawn.length}）</summary>
                    {withdrawn.map((r) => (
                      <p key={r.id}>
                        {r.personName} · {r.correctionReason} · {r.updatedName}
                        <button
                          onClick={() => void showHistory({ ...r, sources: [r], differences: [] })}
                        >
                          查看保留历史
                        </button>
                      </p>
                    ))}
                  </details>
                )}
                <footer>
                  <button
                    type="button"
                    disabled={!canCreate}
                    onClick={() => setSlots((old) => ({ ...old, [slotKey]: count + 1 }))}
                  >
                    ＋ 添加人员
                  </button>
                  <small>移除仅撤回当天记录，历史可追溯</small>
                </footer>
              </ProjectSurface>
              {expanded.includes(projectId) && (
                <ProjectAssessmentSummary
                  projectId={projectId}
                  projectName={projectName}
                  records={statisticsRows}
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
      {correcting && (
        <Modal title="更正当天人员" onClose={() => !correctionBusy && setCorrecting(null)}>
          <div className="modal-body">
            <p>
              将撤回「{correcting.personName}」在 {correcting.date}、{correcting.projectName}{' '}
              的本日记录，保留原始状态和操作历史。其他日期及工地不受影响。
            </p>
            <p>重新选择后，新师傅从未记录开始，不转记原师傅成绩。待同步完成后可更正。</p>
            <AssessmentPersonPicker
              people={people}
              assigned={new Set()}
              excluded={
                new Set(
                  daily
                    .filter(
                      (r) => r.projectId === correcting.projectId && r.date === correcting.date,
                    )
                    .map((r) => r.personId),
                )
              }
              label="更正为其他师傅"
              disabled={correctionBusy}
              onSelect={(id) => void correctRow(id)}
            />
            <button disabled={correctionBusy} className="danger" onClick={() => void correctRow()}>
              确认仅移除当天人员
            </button>
            <button disabled={correctionBusy} onClick={() => setCorrecting(null)}>
              取消
            </button>
          </div>
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
