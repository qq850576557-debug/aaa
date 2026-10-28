import { useEffect, useMemo, useState } from 'react';
import { cloudApi, CloudError } from '../lib/cloud';
import {
  assessmentCandidates,
  assessmentStats,
  checkFields,
  checkLabels,
  keyOf,
  statusLabel,
  type Assessment,
  type AssessmentEdit,
  type CheckField,
  type CheckStatus,
} from '../lib/assessments';
import { type Data } from '../lib/model';
import { useCurrentDate } from '../lib/useCurrentDate';
import { DateField } from './DateField';
import { Confirm, Modal } from './Modal';
import './assessments.css';
type Access = { allowed: boolean; owner: boolean; recorders?: string[] };
type Row = Omit<
  Assessment,
  'id' | 'createdBy' | 'createdName' | 'createdAt' | 'updatedBy' | 'updatedName' | 'updatedAt'
> &
  Partial<Assessment>;
export function AssessmentPanel({ data, isCloud }: { data: Data; isCloud: boolean }) {
  const now = useCurrentDate();
  const [date, setDate] = useState(now),
    [stats, setStats] = useState(false),
    [period, setPeriod] = useState<'month' | 'year' | 'custom'>('month'),
    [from, setFrom] = useState(now.slice(0, 7) + '-01'),
    [to, setTo] = useState(now),
    [project, setProject] = useState(''),
    [person, setPerson] = useState(''),
    [trade, setTrade] = useState(''),
    [field, setField] = useState<CheckField>('photo'),
    [status, setStatus] = useState('');
  const [access, setAccess] = useState<Access | null>(null),
    [records, setRecords] = useState<Assessment[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [selection, setSelection] = useState<string[]>([]);
  const [editing, setEditing] = useState<Row[] | null>(null),
    [draft, setDraft] = useState<Record<CheckField, string>>({
      attendance: '',
      photo: '',
      cleaning: '',
    }),
    [confirm, setConfirm] = useState<AssessmentEdit[] | null>(null),
    [requestId, setRequestId] = useState('');
  const [history, setHistory] = useState<{
      row: Assessment;
      events: {
        id: string;
        actorName: string;
        createdAt: string;
        before: Assessment | null;
        after: Assessment;
      }[];
    } | null>(null),
    [grantOpen, setGrantOpen] = useState(false),
    [accounts, setAccounts] = useState<
      { id: string; displayName: string; login: string; owner: boolean; active: boolean }[]
    >([]),
    [grant, setGrant] = useState<{ id: string; enabled: boolean; name: string } | null>(null);
  const rangeStart = stats
    ? period === 'year'
      ? from.slice(0, 4) + '-01-01'
      : period === 'month'
        ? from.slice(0, 7) + '-01'
        : from
    : date;
  const rangeEnd = stats
    ? period === 'year'
      ? from.slice(0, 4) + '-12-31'
      : period === 'month'
        ? new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0).toLocaleDateString(
            'sv-SE',
          )
        : to
    : date;
  const query = new URLSearchParams({
    from: rangeStart,
    to: rangeEnd,
    ...(project ? { projectId: project } : {}),
    ...(person ? { personId: person } : {}),
    ...(trade ? { tradeId: trade } : {}),
  }).toString();
  function report(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    if (e instanceof CloudError && [401, 403].includes(e.status)) {
      setRecords([]);
      setAccess({ allowed: false, owner: false });
    }
  }
  useEffect(() => {
    setSelection([]);
  }, [query, field, status, stats]);
  useEffect(() => {
    if (!isCloud) return;
    let active = true;
    setError('');
    void (async () => {
      const a = await cloudApi<Access>('/assessments/access');
      if (!active) return;
      setAccess(a);
      if (!a.allowed) {
        setRecords([]);
        return;
      }
      const rows: Assessment[] = [];
      let cursor: string | null = null;
      do {
        const r: { records: Assessment[]; nextCursor: string | null } = await cloudApi(
          '/assessments?' + query + (cursor ? '&cursor=' + cursor : ''),
        );
        rows.push(...r.records);
        cursor = r.nextCursor;
      } while (cursor && active);
      if (active) setRecords(rows);
    })().catch((e) => {
      if (active) report(e);
    });
    return () => {
      active = false;
    };
  }, [isCloud, query, reload]);
  useEffect(() => {
    if (!isCloud) return;
    const refresh = () => {
      if (!document.hidden) setReload((v) => v + 1);
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [isCloud]);
  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    if (!stats)
      for (const key of assessmentCandidates(data, date))
        map.set(keyOf(key), {
          ...key,
          version: 0,
          personName: data.people!.find((p) => p.id === key.personId)!.name,
          projectName: data.projects.find((p) => p.id === key.projectId)!.name,
          tradeName: data.trades.find((p) => p.id === key.tradeId)!.name,
          attendance: 'pending',
          photo: 'pending',
          cleaning: 'pending',
        });
    for (const r of records.filter((r) => r.date >= rangeStart && r.date <= rangeEnd))
      map.set(keyOf(r), r);
    return [...map.values()]
      .filter(
        (r) =>
          (!project || r.projectId === project) &&
          (!person || r.personId === person) &&
          (!trade || r.tradeId === trade) &&
          (!status || r[field] === status),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || a.personName.localeCompare(b.personName));
  }, [data, date, records, stats, project, person, trade, field, status, rangeStart, rangeEnd]);
  const persisted = rows.filter((r): r is Assessment => !!r.id),
    summary = assessmentStats(persisted);
  function edit(target: Row[]) {
    setError('');
    setEditing(target);
    setDraft({
      attendance: target.length === 1 ? target[0].attendance : '',
      photo: target.length === 1 ? target[0].photo : '',
      cleaning: target.length === 1 ? target[0].cleaning : '',
    });
  }
  async function save() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      await cloudApi('/assessments/batch', 'POST', { requestId, confirmed: true, edits: confirm });
      setConfirm(null);
      setEditing(null);
      setSelection([]);
      setReload((v) => v + 1);
    } catch (e) {
      report(e);
      setConfirm(null);
      setEditing(null);
      setReload((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  if (!isCloud)
    return (
      <p className="assessment-local">
        日常考核需在云端登录后使用，数据由服务器保存并授权。本地档案及原有数据保持不变。
      </p>
    );
  if (!access) return <p role="status">正在检查考核权限…</p>;
  if (!access.allowed)
    return (
      <p className="assessment-local">{error || '考核记录仅向负责人及其授权的记录人开放。'}</p>
    );
  return (
    <section className="assessment-panel" aria-label="师傅日常考核">
      <div className="section-heading">
        <h2>{stats ? '师傅考核统计' : '师傅日常考核'}</h2>
        <div className="toolbar">
          <button
            onClick={() => {
              setStats(!stats);
              setSelection([]);
            }}
          >
            {stats ? '返回每日记录' : '师傅考核统计'}
          </button>
          {access.owner && (
            <button
              onClick={() => {
                setGrantOpen(true);
                void cloudApi<{ accounts: typeof accounts }>('/directory')
                  .then((r) => setAccounts(r.accounts))
                  .catch(report);
              }}
            >
              考核记录人授权
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        由监理手工记录微信群报备。未保存不计入统计；待记录不等于未完成。无拍照上传或扣款规则。
      </p>
      <div className="assessment-filters">
        {!stats ? (
          <DateField label="考核日期" value={date} required onChange={setDate} />
        ) : (
          <>
            <label>
              统计周期
              <select
                aria-label="统计周期"
                value={period}
                onChange={(e) => setPeriod(e.target.value as typeof period)}
              >
                <option value="month">月度</option>
                <option value="year">年度</option>
                <option value="custom">自定义范围 / 历史</option>
              </select>
            </label>
            <DateField
              label={period === 'custom' ? '起始日期' : '统计基准日期'}
              value={from}
              required
              onChange={setFrom}
            />
            {period === 'custom' && (
              <DateField label="截止日期" value={to} required min={from} onChange={setTo} />
            )}
          </>
        )}
        <label>
          考核项目
          <select
            aria-label="考核项目"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setTrade('');
            }}
          >
            <option value="">全部项目（含完工）</option>
            {[
              ...new Map([
                ...data.projects.map((p) => [p.id, p.name] as const),
                ...records.map((r) => [r.projectId, r.projectName] as const),
              ]).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          考核工种
          <select aria-label="考核工种" value={trade} onChange={(e) => setTrade(e.target.value)}>
            <option value="">全部工种</option>
            {[
              ...new Map([
                ...data.trades
                  .filter((t) => !project || t.projectId === project)
                  .map((t) => [t.id, t.name] as const),
                ...records
                  .filter((r) => !project || r.projectId === project)
                  .map((r) => [r.tradeId, r.tradeName] as const),
              ]).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          考核师傅
          <select aria-label="考核师傅" value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">全部师傅</option>
            {[
              ...new Map([
                ...(data.people ?? [])
                  .filter((p) => p.role === '施工人员')
                  .map((p) => [p.id, p.name] as const),
                ...records.map((r) => [r.personId, r.personName] as const),
              ]).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          考核项
          <select
            aria-label="考核项"
            value={field}
            onChange={(e) => setField(e.target.value as CheckField)}
          >
            {checkFields.map((f) => (
              <option key={f} value={f}>
                {checkLabels[f]}
              </option>
            ))}
          </select>
        </label>
        <label>
          考核状态
          <select aria-label="考核状态" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {(['pending', 'yes', 'no'] as const).map((s) => (
              <option key={s} value={s}>
                {statusLabel(field, s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {stats && (
        <>
          <p>
            {rangeStart} — {rangeEnd} · {persisted.length} 条已保存记录（同日多工种按独立记录计次）
          </p>
          <div className="assessment-table-scroll">
            <table className="assessment-table" aria-label="师傅考核统计">
              <thead>
                <tr>
                  <th>师傅 / 项目</th>
                  <th>记录次数</th>
                  {(['photo', 'cleaning'] as const).flatMap((f) =>
                    (['yes', 'no', 'pending'] as const).map((s) => (
                      <th key={f + s}>
                        {statusLabel(f, s)}
                        {s === 'pending' ? `（${checkLabels[f]}）` : ''}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.personId + r.projectId}>
                    <th>
                      {r.personName}
                      <small>{r.projectName}</small>
                    </th>
                    <td>{r.total}</td>
                    {(['photo', 'cleaning'] as const).flatMap((f) =>
                      (['yes', 'no', 'pending'] as const).map((s) => (
                        <td key={f + s}>{r.counts[f][s]}</td>
                      )),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={async () => {
              setError('');
              try {
                const extra = status ? `&field=${field}&status=${status}` : '';
                const r = await fetch('/api/assessments/export?' + query + extra, {
                  credentials: 'same-origin',
                });
                if (!r.ok) {
                  const e = await r.json();
                  throw new CloudError(r.status, e.error);
                }
                const blob = await r.blob(),
                  url = URL.createObjectURL(blob),
                  a = document.createElement('a');
                a.href = url;
                a.download = '春茉师傅考核明细.csv';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                report(e);
              }
            }}
          >
            导出考核明细 CSV
          </button>
        </>
      )}
      {!stats && (
        <div className="toolbar">
          <button
            disabled={!selection.length || busy}
            onClick={() => edit(rows.filter((r) => selection.includes(keyOf(r))))}
          >
            批量记录（{selection.length}）
          </button>
          <small>按项目、工种分配的师傅显示；没有分配时请先管理项目分配。</small>
        </div>
      )}
      <div className="assessment-table-scroll">
        <table className="assessment-table" aria-label="师傅每日考核">
          <thead>
            <tr>
              {!stats && <th>选择</th>}
              <th>师傅 / 项目 / 工种</th>
              {stats && <th>日期</th>}
              {checkFields.map((f) => (
                <th key={f}>{checkLabels[f]}</th>
              ))}
              <th>记录</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r)}>
                {!stats && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择${r.personName}·${r.projectName}·${r.tradeName}`}
                      disabled={!selection.includes(keyOf(r)) && selection.length >= 100}
                      checked={selection.includes(keyOf(r))}
                      onChange={(e) =>
                        setSelection(
                          e.target.checked
                            ? [...selection, keyOf(r)]
                            : selection.filter((k) => k !== keyOf(r)),
                        )
                      }
                    />
                  </td>
                )}
                <th>
                  {r.personName}
                  <small>
                    {r.projectName} · {r.tradeName}
                  </small>
                </th>
                {stats && <td>{r.date}</td>}
                {checkFields.map((f) => (
                  <td key={f}>
                    <button
                      className={`assessment-badge ${r[f]}`}
                      aria-label={`${r.personName}·${r.tradeName}·${checkLabels[f]}：${statusLabel(f, r[f])}`}
                      onClick={() => edit([r])}
                    >
                      {statusLabel(f, r[f])}
                    </button>
                  </td>
                ))}
                <td>
                  {r.id ? (
                    <>
                      <small>
                        {r.updatedName}
                        <br />
                        {new Date(r.updatedAt!).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                        })}
                      </small>
                      <button
                        className="text-btn"
                        onClick={() =>
                          void cloudApi<{ events: NonNullable<typeof history>['events'] }>(
                            `/assessments/${r.id}/history`,
                          )
                            .then((v) => setHistory({ row: r as Assessment, events: v.events }))
                            .catch(report)
                        }
                      >
                        修改历史
                      </button>
                    </>
                  ) : (
                    <small>尚未保存</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>暂无记录</p>}
      {editing && (
        <Modal
          title={editing.length === 1 ? '记录师傅考核' : `批量记录 ${editing.length} 条`}
          onClose={() => !busy && setEditing(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const changes = Object.fromEntries(
                checkFields.filter((f) => draft[f]).map((f) => [f, draft[f] as CheckStatus]),
              );
              if (!Object.keys(changes).length) {
                setError('请选择至少一项状态');
                return;
              }
              setRequestId(crypto.randomUUID());
              setConfirm(
                editing.map((r) => ({
                  date: r.date,
                  personId: r.personId,
                  projectId: r.projectId,
                  tradeId: r.tradeId,
                  version: r.version,
                  changes,
                })),
              );
            }}
          >
            <div className="modal-body">
              <ul className="assessment-targets">
                {editing.map((r) => (
                  <li key={keyOf(r)}>
                    {r.date} · {r.personName} · {r.projectName} · {r.tradeName}
                  </li>
                ))}
              </ul>
              {checkFields.map((f) => (
                <label key={f}>
                  {checkLabels[f]}
                  <select
                    aria-label={`记录${checkLabels[f]}`}
                    value={draft[f]}
                    onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
                  >
                    <option value="">保持原值</option>
                    {(['pending', 'yes', 'no'] as const).map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(f, s)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                核对并保存
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {confirm && (
        <Confirm
          title="确认保存考核？"
          message={`${confirm.length} 条记录：${editing?.map((r) => `${r.date} ${r.personName} / ${r.projectName} / ${r.tradeName}`).join('；')}。修改：${checkFields
            .filter((f) => draft[f])
            .map((f) => checkLabels[f] + ' ' + statusLabel(f, draft[f] as CheckStatus))
            .join('、')}。未选择的字段不变。`}
          onCancel={() => !busy && setConfirm(null)}
          onConfirm={() => {
            if (!busy) void save();
          }}
        />
      )}
      {history && (
        <Modal title={`考核历史 · ${history.row.personName}`} onClose={() => setHistory(null)}>
          <div className="modal-body assessment-history">
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
      {grantOpen && (
        <Modal title="考核记录人授权" onClose={() => setGrantOpen(false)}>
          <div className="modal-body recorder-grants">
            <p>
              获授权账号可查看、记录及导出本工作室全部考核。普通员工默认不可读取。负责人始终可操作。
            </p>
            {accounts
              .filter((a) => !a.owner && a.active)
              .map((a) => (
                <label className="recorder-grant-row" key={a.id}>
                  <input
                    type="checkbox"
                    aria-label={`${a.displayName || a.login}（${a.login}）`}
                    checked={access.recorders?.includes(a.id) ?? false}
                    onChange={(e) =>
                      setGrant({
                        id: a.id,
                        enabled: e.target.checked,
                        name: a.displayName || a.login,
                      })
                    }
                  />
                  <span>
                    <strong>{a.displayName || a.login}</strong>
                    <small>（{a.login}）</small>
                  </span>
                </label>
              ))}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setGrantOpen(false)}>关闭</button>
          </footer>
        </Modal>
      )}
      {grant && (
        <Confirm
          title="修改考核授权？"
          message={`${grant.enabled ? '授权' : '撤销'}「${grant.name}」查看、记录及导出本工作室全部考核的权限。不改变其他账号权限。`}
          onCancel={() => setGrant(null)}
          onConfirm={() => {
            void cloudApi(`/assessments/recorders/${encodeURIComponent(grant.id)}`, 'PUT', {
              enabled: grant.enabled,
            })
              .then(() => {
                setGrant(null);
                setReload((v) => v + 1);
              })
              .catch(report);
          }}
        />
      )}
    </section>
  );
}
