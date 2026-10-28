import { transferSuggestions } from '../lib/material-recommendations';
import { TransferPanel } from './TransferPanel';
import { useEffect, useState } from 'react';
import { cloudApi } from '../lib/cloud';
import { type Data, today, distance } from '../lib/model';
import {
  type MaterialState,
  type Material,
  type MaterialContext,
  type MaterialAlert,
  materialAnalysis,
  materialPeriod,
  eventLabels,
  eventKinds,
  alertStatuses,
  milli,
  decimal,
  csvRows,
  yuan,
} from '../lib/materials';
import { DateField } from './DateField';
import { Modal, Confirm } from './Modal';
import './materials.css';
const tabs = [
  '材料总览',
  '工地材料台账',
  '采购、领用及库存流水',
  '跨工地余料调拨',
  '材料消耗分析',
  '异常预警与处理记录',
  '历史统计及 CSV 导出',
];
type State = MaterialState & { analysis: ReturnType<typeof materialAnalysis> };
type Edit = {
  kind: 'item' | 'project' | 'context' | 'event' | 'alert';
  id: string;
  version: number;
  v: Record<string, string | boolean>;
};
const empty: State = {
  materials: [],
  projects: [],
  contexts: [],
  events: [],
  alerts: [],
  analysis: { stocks: [], rows: [], risks: [] },
};
export function MaterialAlertSummary({ onOpen }: { onOpen: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    void cloudApi<{ alerts: MaterialAlert[] }>('/materials/alerts')
      .then((r) => setCount(r.alerts.filter((a) => a.status !== '已关闭').length))
      .catch(() => setCount(null));
  }, []);
  return count === null ? null : (
    <div className="panel">
      <h3>材料核查事项</h3>
      <p>{count ? `${count} 项待核查或待复核` : '暂无待处理材料事项'}</p>
      <button onClick={onOpen}>查看同源材料预警</button>
    </div>
  );
}
export function MaterialsPanel({
  data,
  isCloud,
  initialTab = 0,
}: {
  data: Data;
  isCloud: boolean;
  initialTab?: number;
}) {
  const [tab, setTab] = useState(initialTab),
    [state, setState] = useState<State>(empty),
    [access, setAccess] = useState<{
      allowed: boolean;
      owner: boolean;
      operators?: string[];
    } | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [project, setProject] = useState(''),
    [material, setMaterial] = useState(''),
    [category, setCategory] = useState(''),
    [projectType, setProjectType] = useState(''),
    [phase, setPhase] = useState(''),
    [trade, setTrade] = useState(''),
    [team, setTeam] = useState(''),
    [from, setFrom] = useState(today().slice(0, 7) + '-01'),
    [to, setTo] = useState(today()),
    [period, setPeriod] = useState('month'),
    [edit, setEdit] = useState<Edit | null>(null),
    [confirm, setConfirm] = useState<Edit | null>(null),
    [history, setHistory] = useState<{ title: string; events: unknown[] } | null>(null),
    [permissions, setPermissions] = useState(false),
    [accounts, setAccounts] = useState<
      { id: string; login: string; displayName: string; active: boolean; owner: boolean }[]
    >([]),
    [grant, setGrant] = useState<{ id: string; name: string; enabled: boolean } | null>(null);
  async function refresh(generate = false) {
    const a = await cloudApi<NonNullable<typeof access>>('/materials/access');
    setAccess(a);
    if (!a.allowed) {
      setState(empty);
      return;
    }
    if (generate) await cloudApi('/materials/refresh-alerts', 'POST', {});
    setState(await cloudApi<State>('/materials'));
  }
  useEffect(() => {
    if (isCloud) void refresh().catch((e) => setError(String(e)));
  }, [isCloud]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const nameProject = (id: string) =>
    data.projects.find((p) => p.id === id)?.name ||
    state.projects.find((p) => p.projectId === id)?.projectName ||
    state.events.find((e) => e.projectId === id)?.projectName ||
    id;
  const mat = (id: string) => state.materials.find((m) => m.id === id);
  const typeOfProject = (id: string) =>
    state.projects.find((p) => p.projectId === id)?.projectType || '未设置';
  const applicable = (r: { projectId: string; materialId: string }) =>
    (!project || r.projectId === project) &&
    (!material || r.materialId === material) &&
    (!category || mat(r.materialId)?.category === category) &&
    (!projectType || typeOfProject(r.projectId) === projectType);
  const stocks = state.analysis.stocks.filter(applicable),
    rows = state.analysis.rows.filter(
      (r) =>
        applicable(r) &&
        (!phase || r.phase === phase) &&
        (!trade || r.tradeId === trade) &&
        (!team || r.teamName === team),
    ),
    events = state.events.filter(
      (e) =>
        (!project || e.projectId === project || e.targetProjectId === project) &&
        (!material || e.materialId === material) &&
        (!category || mat(e.materialId)?.category === category) &&
        (!projectType || typeOfProject(e.projectId) === projectType) &&
        e.date >= from &&
        e.date <= to,
    ),
    alerts = state.alerts.filter(applicable);
  function openItem(m?: Material) {
    setError('');
    setEdit({
      kind: 'item',
      id: m?.id ?? '',
      version: m?.version ?? 0,
      v: {
        name: m?.name ?? '',
        category: m?.category ?? '',
        unit: m?.unit ?? 'm²',
        specification: m?.specification ?? '',
        performance: m?.performance ?? '',
        active: m?.active ?? true,
        conversions: m?.conversions.map((c) => c.unit + '|' + c.factor).join('\n') ?? '',
      },
    });
  }
  function openProject(id = project || data.projects[0]?.id) {
    if (!id) {
      setError('请先建立项目');
      return;
    }
    setError('');
    const p = state.projects.find((p) => p.projectId === id);
    setEdit({
      kind: 'project',
      id,
      version: p?.version ?? 0,
      v: {
        projectId: id,
        buildingArea: p?.buildingArea ?? '0',
        constructionArea: p?.constructionArea ?? '0',
        regions: p?.regions.map((r) => r.name + '|' + r.area).join('\n') ?? '',
        projectType: p?.projectType ?? '',
        layout: p?.layout ?? '',
        grade: p?.grade ?? '',
        design: p?.design ?? '',
        transportRate: p?.transportRate ?? '',
      },
    });
  }
  function openContext(c?: MaterialContext) {
    setError('');
    setEdit({
      kind: 'context',
      id: c?.id ?? '',
      version: c?.version ?? 0,
      v: {
        projectId: c?.projectId ?? project,
        materialId: c?.materialId ?? material,
        phase: c?.phase ?? '',
        zone: c?.zone ?? '',
        tradeId: c?.tradeId ?? '',
        taskId: c?.taskId ?? '',
        teamName: c?.teamName ?? '',
        staffIds: c?.staffIds.join(',') ?? '',
        basisKind: c?.basisKind ?? 'area',
        basis: c?.basis ?? '0',
        coats: String(c?.coats ?? 1),
        process: c?.process ?? '',
        paving: c?.paving ?? '',
        budgetQty: c?.budgetQty ?? '0',
        budgetPrice: c?.budgetPrice ?? '0',
        progress: String(c?.progress ?? 0),
        finalized: c?.finalized ?? false,
        actualWorkers: String(c?.actualWorkers ?? 0),
        actualDays: String(c?.actualDays ?? 0),
      },
    });
  }
  function openEvent(kind = 'receipt', p = project, m = material, target = '') {
    setError('');
    setEdit({
      kind: 'event',
      id: crypto.randomUUID(),
      version: 0,
      v: {
        kind,
        projectId: p,
        materialId: m,
        contextId: '',
        targetProjectId: target,
        purchaseId: '',
        date: today(),
        quantity: '0',
        inputUnit: mat(m)?.unit ?? '',
        unitPrice: '0',
        referenceId: '',
        reason: '',
      },
    });
  }
  function openAlert(a: MaterialAlert) {
    setError('');
    setEdit({
      kind: 'alert',
      id: a.id,
      version: a.version,
      v: { status: a.status, assigneeId: a.assigneeId, reason: '' },
    });
    void cloudApi<{ accounts: typeof accounts }>('/directory')
      .then((r) => setAccounts(r.accounts))
      .catch((e) => setError(String(e)));
  }
  async function inspect(id: string, title: string) {
    await action(async () => {
      const r = await cloudApi<{ events: unknown[] }>('/materials/history/' + id);
      setHistory({ title, events: r.events });
    });
  }
  function lines(s: string, a: string, b: string) {
    return s
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((row) => {
        const p = row.split('|');
        if (p.length !== 2) throw Error('每行请按“名称|数值”填写');
        return { [a]: p[0].trim(), [b]: p[1].trim() };
      });
  }
  async function save(e: Edit) {
    await action(async () => {
      const v = e.v;
      let path = '',
        method = 'PUT',
        body: unknown;
      if (e.kind === 'item') {
        path = '/materials/items';
        body = {
          id: e.id,
          version: e.version,
          value: { ...v, conversions: lines(String(v.conversions), 'unit', 'factor') },
        };
      }
      if (e.kind === 'project') {
        path = '/materials/projects';
        const { projectId, regions, ...rest } = v;
        body = {
          id: String(projectId),
          version: e.version,
          value: {
            ...rest,
            transportRate: v.transportRate ? String(v.transportRate) : undefined,
            regions: lines(String(regions), 'name', 'area'),
          },
        };
      }
      if (!project || ('projectId' in v && v.projectId !== project))
        throw Error('工地上下文已变化，请重新打开表单');
      if (e.kind === 'context') {
        path = '/materials/contexts';
        body = {
          id: e.id,
          version: e.version,
          value: {
            ...v,
            staffIds: String(v.staffIds)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            coats: Number(v.coats),
            progress: Number(v.progress),
            actualWorkers: Number(v.actualWorkers),
            actualDays: Number(v.actualDays),
          },
        };
      }
      if (e.kind === 'event') {
        path = '/materials/events';
        method = 'POST';
        body = { ...v, requestId: e.id };
      }
      if (e.kind === 'alert') {
        path = '/materials/alerts/' + e.id;
        body = { ...v, version: e.version };
      }
      await cloudApi(path, method, body);
      setConfirm(null);
      setEdit(null);
      await refresh();
      setNotice('服务端已保存，相关库存、核算和预警已更新。');
    });
    setConfirm(null);
  }
  async function exportLedger() {
    await action(async () => {
      const q = new URLSearchParams({
        from,
        to,
        ...(project ? { projectId: project } : {}),
        ...(material ? { materialId: material } : {}),
        ...(category ? { category } : {}),
        ...(projectType ? { projectType } : {}),
      });
      const r = await fetch('/api/materials/export?' + q, { credentials: 'same-origin' });
      if (!r.ok) throw Error((await r.json()).error);
      download(await r.blob(), '春茉材料流水.csv');
    });
  }
  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!isCloud)
    return (
      <section className="panel">
        <h2>材料资产管理</h2>
        <p>
          请登录云端工作空间使用。材料数量、单价及核查记录由服务端统一授权保存，不使用本地模拟权限。
        </p>
      </section>
    );
  if (!access) return <p role="status">正在读取材料权限…{error}</p>;
  if (!access.allowed)
    return (
      <section className="panel">
        <h2>材料资产管理</h2>
        <p>仅负责人或其授权的材料管理人可查看、记录及导出。</p>
      </section>
    );
  const idle = stocks.filter(
      (s) => Number(s.siteQty) > 0 && s.siteDate && distance(s.siteDate, today()) >= 30,
    ),
    pending = alerts.filter((a) => a.status !== '已关闭');
  const transfers = project ? transferSuggestions(state, data, project) : [];
  const kinds = eKindOptions();
  function eKindOptions() {
    return eventKinds
      .filter((k) => k !== 'transfer' && !k.startsWith('transfer_'))
      .filter((k) => access?.owner || !['reverse', 'reopen'].includes(k))
      .map((k) => [k, eventLabels[k]] as [string, string]);
  }
  const table = (heads: string[], body: React.ReactNode) => (
    <div className="material-table-scroll">
      <table className="material-table">
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
  return (
    <section className="panel materials-panel" aria-label="材料资产管理">
      <div className="section-heading">
        <div>
          <h2>材料资产管理</h2>
          <p className="muted">数量、领用、实际使用与损耗分开核算；预警只用于核查，不认定责任。</p>
        </div>
        <div className="toolbar">
          <button disabled={busy || !project} onClick={() => void action(() => refresh(true))}>
            刷新核算与预警
          </button>
          {access.owner && (
            <button
              onClick={() => {
                setPermissions(true);
                void cloudApi<{ accounts: typeof accounts }>('/directory')
                  .then((r) => setAccounts(r.accounts))
                  .catch((e) => setError(String(e)));
              }}
            >
              材料权限
            </button>
          )}
        </div>
      </div>
      <nav className="material-tabs" aria-label="材料子页面">
        {tabs.map((t, i) => (
          <button key={t} aria-current={tab === i ? 'page' : undefined} onClick={() => setTab(i)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="material-filters">
        <label>
          材料类别
          <select
            aria-label="材料类别"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setMaterial('');
            }}
          >
            <option value="">全部类别</option>
            {[...new Set(state.materials.map((m) => m.category))].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          项目类型筛选
          <select
            aria-label="项目类型筛选"
            value={projectType}
            onChange={(e) => setProjectType(e.target.value)}
          >
            <option value="">全部项目类型</option>
            {[...new Set(['未设置', ...state.projects.map((p) => p.projectType)])].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          材料项目
          <select
            aria-label="材料项目"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setEdit(null);
              setConfirm(null);
              setMaterial('');
              setNotice('当前操作工地已切换，请核对下方工地名称。');
            }}
          >
            <option value="">请先选择工地</option>
            {[
              ...new Map([
                ...data.projects.map((p) => [p.id, p.name] as const),
                ...state.projects.map((p) => [p.projectId, p.projectName] as const),
              ]).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          材料规格筛选
          <select
            aria-label="材料规格筛选"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
          >
            <option value="">全部规格（数量不混加）</option>
            {state.materials
              .filter((m) => !category || m.category === category)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.specification} · {m.unit}
                </option>
              ))}
          </select>
        </label>
        {tab === 4 && (
          <>
            <label>
              阶段
              <select value={phase} onChange={(e) => setPhase(e.target.value)}>
                <option value="">全部阶段</option>
                {[...new Set(state.contexts.map((c) => c.phase))].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              工种
              <select value={trade} onChange={(e) => setTrade(e.target.value)}>
                <option value="">全部工种</option>
                {data.trades
                  .filter((t) => !project || t.projectId === project)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {nameProject(t.projectId)} · {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              班组
              <select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">全部班组</option>
                {[...new Set(state.contexts.map((c) => c.teamName))].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="material-notice" role="status">
          {notice}
        </p>
      )}
      {busy && <p role="status">正在保存/核验…</p>}
      <p className="material-project-context" role="status">
        {project
          ? `当前操作工地：${nameProject(project)}`
          : '请先选择工地。未选择时材料操作不可用。'}
      </p>
      <fieldset className="material-workarea" disabled={!project} hidden={!project}>
        {tab === 0 && (
          <>
            <p className="form-info">
              材料台账、名片和授权需使用服务器加密数据库备份；项目 JSON 不含这些独立记录，CSV
              供核对与统计。
            </p>
            <div className="material-overview">
              <button type="button" onClick={() => setTab(1)}>
                库存规格/工地
                <strong>{stocks.filter((s) => Number(s.totalQty) > 0).length || '暂无'}</strong>
              </button>
              <button type="button" onClick={() => setTab(1)}>
                账面估算价值
                <strong>
                  {state.events.length
                    ? '¥ ' + yuan(stocks.reduce((n, s) => n + BigInt(s.valueMicros), 0n))
                    : '暂无'}
                </strong>
              </button>
              <button type="button" onClick={() => setTab(0)}>
                近30天无流水余料<strong>{idle.length || '暂无'}</strong>
              </button>
              <button type="button" onClick={() => setTab(3)}>
                待调拨建议<strong>{transfers.length || '暂无'}</strong>
              </button>
              <button type="button" onClick={() => setTab(1)}>
                账实差异
                <strong>
                  {stocks.filter((s) => s.counts.some((c) => Number(c.difference) !== 0)).length ||
                    '暂无'}
                </strong>
              </button>
              <button type="button" onClick={() => setTab(5)}>
                待核查/待复核<strong>{pending.length || '暂无'}</strong>
              </button>
            </div>
            <div className="toolbar">
              <button disabled={!access.owner} onClick={() => openItem()}>
                新增材料规格
              </button>
              <button onClick={() => openEvent()}>登记库存流水</button>
              <button onClick={() => setTab(5)}>查看核查事项</button>
            </div>
            {table(
              ['材料/类别', '规格、性能及单位', '换算', '状态', '操作'],
              state.materials.map((m) => (
                <tr key={m.id}>
                  <th>
                    {m.name}
                    <small>{m.category}</small>
                  </th>
                  <td>
                    {m.specification}
                    <small>
                      {m.performance} · {m.unit}
                    </small>
                  </td>
                  <td>
                    {m.conversions.map((c) => `1${c.unit}=${c.factor}${m.unit}`).join('；') ||
                      '仅基准单位'}
                  </td>
                  <td>{m.active ? '在用' : '已停用'}</td>
                  <td>
                    {access.owner && <button onClick={() => openItem(m)}>编辑规格</button>}
                    <button onClick={() => void inspect(m.id, m.name)}>历史</button>
                  </td>
                </tr>
              )),
            )}
            {idle.map((s) => (
              <p key={s.projectId + s.materialId}>
                {nameProject(s.projectId)} · {mat(s.materialId)?.name}：{s.siteQty}
                {mat(s.materialId)?.unit}，最近现场出入库 {s.siteDate}
                。请核对闲置状态和其他工地计划。
              </p>
            ))}
          </>
        )}
        {tab === 1 && (
          <>
            <div className="toolbar">
              <button onClick={() => openProject()}>项目比较条件</button>
              <button onClick={() => openContext()}>新增核算阶段</button>
            </div>
            {dateRange()}
            {table(
              [
                '期间期初 / 期末账面',
                '工地 / 规格',
                '当期入场 / 使用 / 损耗',
                '期末实盘 / 待核差',
                '数量勾稽',
              ],
              materialPeriod(state.events, from, to)
                .filter(applicable)
                .map((r) => (
                  <tr key={r.projectId + r.materialId}>
                    <td>
                      {r.begin} / {r.endBook}
                    </td>
                    <th>
                      {nameProject(r.projectId)}
                      <small>
                        {mat(r.materialId)?.name} · {mat(r.materialId)?.unit}
                      </small>
                    </th>
                    <td>
                      {r.received} / {r.used} / {r.loss}
                      <small>
                        期内期初入账 {r.opening}；调入 {r.transferIn} / 调出 {r.transferOut}；退货{' '}
                        {r.supplierReturn}；差异调整 {r.adjustment}
                      </small>
                    </td>
                    <td>
                      {r.endPhysical ?? '未在期末完成各库位盘点'} / {r.unverified}
                    </td>
                    <td>{r.check ? '数量守恒' : '核算异常'}</td>
                  </tr>
                )),
            )}
            {table(
              [
                '工地/规格',
                '现场库存 / 班组余料',
                '采购 / 入场',
                '实际使用 / 已确认损耗',
                '估算价值 / 差异',
                '追溯',
              ],
              stocks.map((s) => (
                <tr key={s.projectId + s.materialId}>
                  <th>
                    {nameProject(s.projectId)}
                    <small>
                      {mat(s.materialId)?.name} · {mat(s.materialId)?.unit}
                      {s.closed ? ' · 已清仓关闭' : ''}
                    </small>
                  </th>
                  <td>
                    {s.siteQty} / {s.crewQty}
                  </td>
                  <td>
                    {s.ordered} / {s.received}
                  </td>
                  <td>
                    {s.used} / {s.loss}
                    {Number(s.transitLoss) > 0 && (
                      <small>
                        在途损耗另列 {s.transitLoss}，成本 ¥{s.transitLossCost}
                        （已计调出，不再重复扣减）
                      </small>
                    )}
                    <small>采购不等于使用；领用未消耗仍为资产</small>
                  </td>
                  <td>
                    ¥ {s.value}
                    <small>
                      {s.counts.map((c) => `盘点${c.id}：差异${c.difference}`).join('；') ||
                        '尚无盘点'}
                    </small>
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        setProject(s.projectId);
                        setFrom('1900-01-01');
                        setTo(today());
                        setMaterial(s.materialId);
                        setTab(2);
                      }}
                    >
                      原始流水
                    </button>
                    <button onClick={() => openEvent('count_site', s.projectId, s.materialId)}>
                      盘点
                    </button>
                    <button
                      onClick={() =>
                        openEvent(s.closed ? 'reopen' : 'close', s.projectId, s.materialId)
                      }
                      disabled={s.closed && !access.owner}
                    >
                      {s.closed ? '重开' : '完工清仓'}
                    </button>
                  </td>
                </tr>
              )),
            )}
            {table(
              [
                '阶段/区域',
                '工地 / 材料',
                '班组 / 施工关联',
                '实际基数与预算',
                '进度 / 核算',
                '操作',
              ],
              state.contexts.filter(applicable).map((c) => (
                <tr key={c.id}>
                  <th>
                    {c.phase}
                    <small>{c.zone}</small>
                  </th>
                  <td>
                    {c.projectName}
                    <small>{mat(c.materialId)?.name}</small>
                  </td>
                  <td>
                    {c.teamName}
                    <small>
                      {data.trades.find((g) => g.id === c.tradeId)?.name} ·{' '}
                      {data.tasks.find((t) => t.id === c.taskId)?.name} ·{' '}
                      {c.staffIds
                        .map((id) => data.people?.find((p) => p.id === id)?.name || id)
                        .join('、')}
                    </small>
                  </td>
                  <td>
                    {c.basis}{' '}
                    {c.basisKind === 'length'
                      ? 'm'
                      : c.basisKind === 'area_coats'
                        ? `m²×${c.coats}遍`
                        : 'm²'}
                    <small>
                      预算{c.budgetQty}
                      {mat(c.materialId)?.unit} / ¥{c.budgetPrice}
                    </small>
                  </td>
                  <td>
                    {c.progress}% · {c.finalized ? '核算完成' : '核算中'}
                  </td>
                  <td>
                    <button onClick={() => openContext(c)}>编辑阶段</button>
                    <button onClick={() => void inspect(c.id, c.phase)}>历史</button>
                  </td>
                </tr>
              )),
            )}
          </>
        )}
        {tab === 2 && (
          <>
            <div className="toolbar">
              <button onClick={() => openEvent()}>登记材料流水</button>
            </div>
            {dateRange()}
            {table(
              [
                '日期/流水',
                '工地/材料',
                '类型/基准数量',
                '班组阶段 / 来源',
                '价值与操作人',
                '详情',
              ],
              events.map((e) => (
                <tr key={e.id}>
                  <th>
                    {e.date}
                    <small>#{e.seq}</small>
                  </th>
                  <td>
                    {e.projectName}
                    <small>
                      {e.materialName} · {e.unit}
                    </small>
                  </td>
                  <td>
                    {eventLabels[e.kind]}
                    <small>
                      {e.baseQty} {e.unit}（原录{e.quantity}
                      {e.inputUnit}×{e.conversionFactor}）
                    </small>
                  </td>
                  <td>
                    {state.contexts.find((c) => c.id === e.contextId)?.phase}
                    <small>
                      {e.purchaseId
                        ? '关联采购：' +
                          (data.purchases.find((p) => p.id === e.purchaseId)?.name || e.purchaseId)
                        : ''}
                      {e.targetProjectId ? ' → ' + nameProject(e.targetProjectId) : ''}
                    </small>
                    <small>{e.reason}</small>
                  </td>
                  <td>
                    ¥ {yuan(BigInt(e.costMicros || '0'))}
                    <small>
                      {e.actorName} · {new Date(e.at).toLocaleString()}
                    </small>
                  </td>
                  <td>
                    <button onClick={() => void inspect(e.id, '材料原始流水')}>原始记录</button>
                    {access.owner && (
                      <button
                        onClick={() => {
                          openEvent('reverse', e.projectId, e.materialId);
                          setEdit((v) => (v ? { ...v, v: { ...v.v, referenceId: e.id } } : v));
                        }}
                      >
                        冲销
                      </button>
                    )}
                  </td>
                </tr>
              )),
            )}
          </>
        )}
        {tab === 3 && project && (
          <TransferPanel
            data={data}
            state={state}
            project={project}
            owner={access.owner}
            onSaved={() => refresh()}
          />
        )}
        {tab === 4 && (
          <>
            <p className="form-info">
              按实际施工区域面积、长度或涂刷面积×遍数比较，绝不直接以建筑面积替代。参考区间为同类项目Q1−1.5IQR至Q3+1.5IQR，至少5个不同项目；是统计核查提示，不是校准概率或责任判断。
            </p>
            {rows.map((r) => (
              <article className="material-risk" key={r.id}>
                <h3>
                  {r.projectName} · {mat(r.materialId)?.name} · {r.phase} / {r.teamName}
                </h3>
                <p>
                  已使用 {r.used} + 已确认损耗 {r.loss} = 总耗 {r.actual}
                  {mat(r.materialId)?.unit}；实际成本 ¥{r.actualCost}；预算量 {r.budgetQty}
                  ，成本偏差 ¥{r.costVariance}
                </p>
                <p>
                  核实人数 {r.actualWorkers || '未知'} · 核实施工天数 {r.actualDays || '未知'}
                  ；基数：{r.basis} {r.basisValue}；单位消耗 {r.current?.toFixed(4) ?? '暂无'}
                  ；损耗率 {r.lossRate === null ? '暂无' : (r.lossRate * 100).toFixed(2) + '%'}
                </p>
                <p>
                  可比历史 {r.samples} 个项目；均值 {r.mean?.toFixed(4) ?? '暂无'}；中位数{' '}
                  {r.median?.toFixed(4) ?? '暂无'}；区间{' '}
                  {r.lower === null ? '暂无' : `${r.lower.toFixed(4)}—${r.upper!.toFixed(4)}`}
                </p>
                <p>
                  {r.reason}
                  {r.missing.length ? '；缺失/待核实：' + r.missing.join('、') : ''}
                </p>
                <p>
                  完工超额估算 {r.estimatedExcess === null ? '暂无' : r.estimatedExcess.toFixed(3)}
                  ，对应成本估算{' '}
                  {r.estimatedCost === null ? '暂无' : '¥' + r.estimatedCost.toFixed(2)}
                  。未经历史校准，不显示精确概率。
                </p>
                <p>
                  单位施工基数成本{' '}
                  {r.unitBasisCost === null ? '暂无' : '¥' + r.unitBasisCost.toFixed(2)}
                  ；单位实际面积成本{' '}
                  {r.unitAreaCost === null ? '不适用/缺基数' : '¥' + r.unitAreaCost.toFixed(2)}
                  ；历史单位基数成本中位数{' '}
                  {r.medianUnitCost === null ? '暂无' : '¥' + r.medianUnitCost.toFixed(2)}
                  ；相对历史耗量偏差{' '}
                  {r.relativeConsumption === null
                    ? '暂无'
                    : (r.relativeConsumption * 100).toFixed(2) + '%'}
                  ；相对历史成本偏差{' '}
                  {r.relativeCost === null ? '暂无' : (r.relativeCost * 100).toFixed(2) + '%'}
                  ；单位基数成本差额{' '}
                  {r.unitCostDifference === null ? '暂无' : '¥' + r.unitCostDifference.toFixed(2)}。
                </p>
                <details>
                  <summary>参考项目与计算口径</summary>
                  {r.references.map((ref) => (
                    <p key={ref.projectId}>
                      <button
                        onClick={() => {
                          setProject(ref.projectId);
                          setFrom('1900-01-01');
                          setTo(today());
                          setMaterial(r.materialId);
                          setTab(2);
                        }}
                      >
                        {ref.projectName}
                      </button>{' '}
                      单位耗量 {ref.ratio.toFixed(4)}
                    </p>
                  ))}
                  <p>
                    相同材料ID（规格/性能/基准单位）、阶段、基数种类、工艺、铺贴方式、项目类型、户型、档次及设计条件；仅纳入核算完成、无未核实差异和班组余料的其他项目。多区域按基数加权合为一项目样本。
                  </p>
                </details>
                <button
                  onClick={() => {
                    setProject(r.projectId);
                    setFrom('1900-01-01');
                    setTo(today());
                    setMaterial(r.materialId);
                    setTab(2);
                  }}
                >
                  追溯原始流水
                </button>
              </article>
            ))}
          </>
        )}
        {tab === 5 && (
          <>
            {!alerts.length && <p>暂无已生成预警；样本不足不会生成虚构异常或概率。</p>}
            {alerts.map((a) => (
              <article className="material-risk" key={a.id}>
                <h3>
                  {a.detail.level} · {nameProject(a.projectId)} · {mat(a.materialId)?.name}
                  <span className="material-status">{a.status}</span>
                </h3>
                <p>{a.detail.reason}</p>
                <p>
                  历史样本 {a.detail.samples}，参考项目{' '}
                  {a.detail.references.map((p) => p.projectName).join('、') || '无'}
                  ；数据完整度限制：
                  {a.detail.missing.join('、') || '当前条件已满足'}。
                </p>
                <ul>
                  {a.detail.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <p>
                  {a.sourceResolved
                    ? '源条件已变化/差异已核销，仍需人工复核关闭。'
                    : '当前源条件仍需核查。'}{' '}
                  · 责任账号 {a.assigneeId || '未分配'} · {a.reason}
                </p>
                <button onClick={() => openAlert(a)}>记录核查与复核</button>
                <button onClick={() => void inspect(a.id, '异常处理历史')}>处理历史</button>
                <button
                  onClick={() => {
                    setProject(a.projectId);
                    setFrom('1900-01-01');
                    setTo(today());
                    setMaterial(a.materialId);
                    setTab(2);
                  }}
                >
                  关联流水
                </button>
              </article>
            ))}
          </>
        )}
        {tab === 6 && (
          <>
            {dateRange()}
            <label>
              趋势周期
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="month">月份</option>
                <option value="year">年度</option>
              </select>
            </label>
            <p>
              各材料规格和项目类型分别统计，不将不同单位/规格强行加总排名。数量和成本为当期使用及损耗（含冲销更正），非采购金额。
            </p>
            {trendCharts()}
            <div className="toolbar">
              <button onClick={() => void exportLedger()}>导出原始流水 CSV</button>
              <button
                onClick={() => {
                  const output = periodStats();
                  download(
                    new Blob(
                      [
                        csvRows([
                          [
                            '周期',
                            '项目类型',
                            '材料ID',
                            '材料',
                            '类别',
                            '规格',
                            '基准单位',
                            '净实际总耗',
                            '实际总耗成本',
                          ],
                          ...output.map((r) => [
                            r.period,
                            r.projectType,
                            r.materialId,
                            r.name,
                            r.category,
                            r.specification,
                            r.unit,
                            decimal(r.q),
                            yuan(r.cost),
                          ]),
                        ]),
                      ],
                      { type: 'text/csv;charset=utf-8' },
                    ),
                    '春茉材料趋势.csv',
                  );
                }}
              >
                导出统计 CSV
              </button>
            </div>
            {table(
              ['周期/项目类型', '材料规格', '实际总耗', '成本', '追溯'],
              periodStats().map((r) => (
                <tr key={r.key}>
                  <th>
                    {r.period}
                    <small>{r.projectType}</small>
                  </th>
                  <td>
                    {r.name}
                    <small>
                      {r.category} · {r.specification}
                    </small>
                  </td>
                  <td>
                    {decimal(r.q)} {r.unit}
                  </td>
                  <td>¥ {yuan(r.cost)}</td>
                  <td>
                    <button onClick={() => openPeriod(r)}>查看原始记录</button>
                  </td>
                </tr>
              )),
            )}
          </>
        )}
        {!state.materials.length && (
          <p>暂无材料数据，请由负责人先登记规格、计量单位及明确换算规则。</p>
        )}
      </fieldset>
      {edit && (
        <Modal
          title={
            edit.kind === 'item'
              ? '材料规格'
              : edit.kind === 'project'
                ? '项目比较条件'
                : edit.kind === 'context'
                  ? '施工阶段与核算基数'
                  : edit.kind === 'alert'
                    ? '材料异常核查'
                    : '材料库存流水'
          }
          onClose={() => !busy && setEdit(null)}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setConfirm(structuredClone(edit));
            }}
          >
            <div className="modal-body form-grid">
              {fields()}
              {error && (
                <p className="error span2" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setEdit(null)} disabled={busy}>
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
          title="确认材料操作？"
          danger={false}
          message={
            confirm.kind === 'event'
              ? `${eventLabels[confirm.v.kind as keyof typeof eventLabels]}：${nameProject(String(confirm.v.projectId))} · ${mat(String(confirm.v.materialId))?.name}，原录数量 ${confirm.v.quantity}${confirm.v.inputUnit}。${confirm.v.targetProjectId ? '接收：' + nameProject(String(confirm.v.targetProjectId)) : ''} 原始流水不可删除，后续更正保留历史。单价为0将按零价值入账，请核实凭据。`
              : '将保存当前核算条件或核查结论，保留操作人、时间和修改历史；不会处罚员工或更改评价。'
          }
          onCancel={() => !busy && setConfirm(null)}
          onConfirm={() => {
            if (!busy) void save(confirm);
          }}
        />
      )}
      {history && (
        <Modal title={history.title} onClose={() => setHistory(null)} wide>
          <div className="modal-body">
            {history.events.map((r, i) => (
              <details key={i} open>
                <summary>记录 {history.events.length - i}</summary>
                <pre className="material-source">{JSON.stringify(r, null, 2)}</pre>
              </details>
            ))}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setHistory(null)}>关闭</button>
          </footer>
        </Modal>
      )}
      {permissions && (
        <Modal title="材料权限" onClose={() => setPermissions(false)}>
          <div className="modal-body recorder-grants">
            <p>
              授予本工作室材料读取、记录、统计及导出权限；不包含手机号、生日、账号管理。规格维护、冲销和重开仍仅负责人执行。
            </p>
            {accounts
              .filter((a) => !a.owner && a.active)
              .map((a) => (
                <label className="recorder-grant-row" key={a.id}>
                  <input
                    type="checkbox"
                    checked={access.operators?.includes(a.id) ?? false}
                    onChange={(e) =>
                      setGrant({
                        id: a.id,
                        name: a.displayName || a.login,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  <span>
                    {a.displayName || a.login}
                    <small>（{a.login}）</small>
                  </span>
                </label>
              ))}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setPermissions(false)}>关闭</button>
          </footer>
        </Modal>
      )}
      {grant && (
        <Confirm
          title="修改材料权限？"
          message={`${grant.enabled ? '授权' : '撤销'}「${grant.name}」本工作室材料操作权限。`}
          onCancel={() => setGrant(null)}
          onConfirm={() =>
            void action(async () => {
              await cloudApi('/materials/operators/' + grant.id, 'PUT', { enabled: grant.enabled });
              setGrant(null);
              await refresh();
            })
          }
        />
      )}
    </section>
  );
  function dateRange() {
    return (
      <div className="material-filters">
        <DateField label="流水起始日期" value={from} onChange={setFrom} />
        <DateField label="流水截止日期" value={to} min={from} onChange={setTo} />
      </div>
    );
  }
  function periodStats() {
    const map = new Map<
      string,
      {
        key: string;
        period: string;
        projectType: string;
        materialId: string;
        name: string;
        category: string;
        specification: string;
        unit: string;
        q: bigint;
        cost: bigint;
      }
    >();
    for (const e of events) {
      const original = e.kind === 'reverse' ? state.events.find((x) => x.id === e.referenceId) : e;
      if (!original || !['use', 'loss_site', 'loss_crew'].includes(original.kind)) continue;
      const m = mat(e.materialId)!;
      const p = state.projects.find((p) => p.projectId === e.projectId);
      const key = JSON.stringify([
        e.date.slice(0, period === 'year' ? 4 : 7),
        p?.projectType ?? '未设置',
        m.id,
      ]);
      const r = map.get(key) ?? {
        key,
        period: e.date.slice(0, period === 'year' ? 4 : 7),
        projectType: p?.projectType ?? '未设置',
        materialId: m.id,
        name: m.name,
        category: m.category,
        specification: m.specification,
        unit: m.unit,
        q: 0n,
        cost: 0n,
      };
      r.q += milli(original.baseQty) * (e.kind === 'reverse' ? -1n : 1n);
      r.cost += BigInt(e.costMicros || '0');
      map.set(key, r);
    }
    return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
  }
  function openPeriod(r: { period: string; materialId: string; projectType: string }) {
    setMaterial(r.materialId);
    setProjectType(r.projectType);
    setFrom(r.period.length === 4 ? r.period + '-01-01' : r.period + '-01');
    setTo(
      r.period.length === 4
        ? r.period + '-12-31'
        : new Date(Date.UTC(Number(r.period.slice(0, 4)), Number(r.period.slice(5, 7)), 0))
            .toISOString()
            .slice(0, 10),
    );
    setTab(2);
  }
  function trendCharts() {
    const groups = new Map<string, ReturnType<typeof periodStats>>();
    for (const r of periodStats()) {
      const key = JSON.stringify([r.materialId, r.projectType]);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups].map(([key, series]) => {
      const maximum = Math.max(1, ...series.map((r) => Math.abs(Number(r.q))));
      const first = series[0];
      return (
        <figure className="material-chart" key={key}>
          <figcaption>
            {first.name} · {first.specification} · {first.projectType}
            <small>净实际总耗（{first.unit}），含更正；负值为当期净冲销。点击可追溯。</small>
          </figcaption>
          <div className="material-chart-series">
            {series.map((r) => (
              <button
                key={r.key}
                onClick={() => openPeriod(r)}
                aria-label={`追溯${r.period}材料总耗${decimal(r.q)}${r.unit}`}
              >
                <span className="material-chart-column" aria-hidden="true">
                  <i
                    className={r.q < 0n ? 'negative' : ''}
                    style={{ height: `${(Math.abs(Number(r.q)) / maximum) * 100}%` }}
                  />
                </span>
                <strong>
                  {decimal(r.q)} {r.unit}
                </strong>
                <small>
                  {r.period} · ¥{yuan(r.cost)}
                </small>
              </button>
            ))}
          </div>
        </figure>
      );
    });
  }
  function fields() {
    if (!edit) return null;
    const v = edit.v;
    const set = (k: string, value: string | boolean) =>
      setEdit({ ...edit, v: { ...v, [k]: value } });
    const input = (k: string, label: string, required = true) => (
      <label key={k}>
        {label}
        <input
          aria-label={label}
          required={required}
          value={String(v[k] ?? '')}
          onChange={(e) => set(k, e.target.value)}
        />
      </label>
    );
    const area = (k: string, label: string) => (
      <label className="span2" key={k}>
        {label}
        <textarea
          aria-label={label}
          rows={3}
          value={String(v[k] ?? '')}
          onChange={(e) => set(k, e.target.value)}
        />
      </label>
    );
    const select = (k: string, label: string, options: [string, string][], optional = false) => (
      <label key={k}>
        {label}
        <select
          aria-label={label}
          required={!optional}
          value={String(v[k] ?? '')}
          onChange={(e) => {
            const value = e.target.value;
            setEdit({
              ...edit,
              v: {
                ...v,
                [k]: value,
                ...(edit.kind === 'event' && k === 'materialId'
                  ? { inputUnit: mat(value)?.unit ?? '', contextId: '', referenceId: '' }
                  : {}),
                ...(edit.kind === 'context' && k === 'tradeId' ? { taskId: '' } : {}),
                ...(k === 'projectId' && edit.kind === 'event'
                  ? { contextId: '', purchaseId: '', referenceId: '', targetProjectId: '' }
                  : {}),
                ...(k === 'projectId' && edit.kind === 'context'
                  ? { tradeId: '', taskId: '', staffIds: '' }
                  : {}),
              },
            });
          }}
        >
          <option value="">{optional ? '不关联' : '请选择'}</option>
          {options.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
    const check = (k: string, label: string) => (
      <label className="check span2" key={k}>
        <input type="checkbox" checked={!!v[k]} onChange={(e) => set(k, e.target.checked)} />
        {label}
      </label>
    );
    const projects = data.projects
        .filter((p) => p.id === project)
        .map((p) => [p.id, p.name] as [string, string]),
      materials = state.materials.map(
        (m) => [m.id, m.name + ' · ' + m.specification + ' / ' + m.unit] as [string, string],
      );
    if (edit.kind === 'item')
      return (
        <>
          {input('name', '材料名称')}
          {input('category', '材料类别')}
          {input('unit', '基准计量单位')}
          {input('specification', '规格型号')}
          {input('performance', '材料性能/等级')}
          {check('active', '在用规格')}
          {area('conversions', '明确单位换算：每行 单位|相当于多少基准单位')}
          <p className="form-info span2">
            例：箱|1.44，表示1箱=1.44m²。已有流水或核算引用后，不允许改变单位、规格、性能或换算，需新增独立规格。
          </p>
        </>
      );
    if (edit.kind === 'project')
      return (
        <>
          {select('projectId', '基础数据所属项目', projects)}
          {input('buildingArea', '建筑面积 m²')}
          {input('constructionArea', '实际施工面积 m²')}
          {input('projectType', '项目类型')}
          {input('layout', '户型特征')}
          {input('grade', '装修档次')}
          {input('design', '设计方案/可比条件')}
          {input('transportRate', '运输估算 元/基准单位（需核实）', false)}
          {area('regions', '施工区域面积：每行 区域名称|面积')}
          <p className="form-info span2">
            建筑面积不自动用作耗量分母；区域和实际基数需监理核对，0代表尚未核实，不能进入可比样本。
          </p>
        </>
      );
    if (edit.kind === 'context')
      return (
        <>
          {select('projectId', '核算所属项目', projects)}
          {select('materialId', '核算材料规格', materials)}
          {input('phase', '施工阶段')}
          {input('zone', '施工区域标识（同阶段不重复）')}
          {select(
            'tradeId',
            '所属施工工种',
            data.trades.filter((t) => t.projectId === v.projectId).map((t) => [t.id, t.name]),
            true,
          )}
          {select(
            'taskId',
            '关联施工任务',
            data.tasks
              .filter((t) => t.projectId === v.projectId && (!v.tradeId || t.tradeId === v.tradeId))
              .map((t) => [t.id, t.name]),
            true,
          )}
          {input('teamName', '班组名称')}
          {input('actualWorkers', '经核实实际施工人数（未知填0）')}
          {input('actualDays', '经核实实际施工天数（未知填0）')}
          {
            <label>
              班组人员
              <select
                multiple
                aria-label="班组人员"
                value={String(v.staffIds).split(',').filter(Boolean)}
                onChange={(e) =>
                  set('staffIds', [...e.target.selectedOptions].map((o) => o.value).join(','))
                }
              >
                {data.people
                  ?.filter((p) => !p.deleted)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          }
          {select('basisKind', '实际消耗基数', [
            ['area', '实际施工区域面积 m²'],
            ['length', '实际施工/布线长度 m'],
            ['area_coats', '实际涂刷面积 × 遍数'],
          ])}
          {input('basis', '实际基数数值')}
          {input('coats', '涂刷遍数（其他基数填1）')}
          {input('process', '施工工艺')}
          {input('paving', '铺贴/布线/涂刷方式')}
          {input('budgetQty', '预算用量（材料基准单位）')}
          {input('budgetPrice', '预算单价 元/基准单位')}
          {input('progress', '监理确认实际进度 %')}
          {check('finalized', '阶段已完成并核算复核（需任务或项目已完工）')}
        </>
      );
    if (edit.kind === 'alert')
      return (
        <>
          {select(
            'status',
            '处理状态',
            alertStatuses.map((s) => [s, s]),
          )}
          {select(
            'assigneeId',
            '核查责任账号',
            accounts.filter((a) => a.active).map((a) => [a.id, a.displayName || a.login]),
            true,
          )}
          {area('reason', '核查/处理/复核原因（必填）')}
        </>
      );
    const m = mat(String(v.materialId));
    return (
      <>
        {select('kind', '流水类型', kinds)}
        {select('projectId', '流水所属项目', projects)}
        {select('materialId', '流水材料规格', materials)}
        {
          <DateField
            label="实际发生日期"
            value={String(v.date)}
            required
            onChange={(d) => set('date', d)}
          />
        }
        {select(
          'contextId',
          '施工阶段/班组（使用及损耗必选）',
          state.contexts
            .filter((c) => c.projectId === v.projectId && c.materialId === v.materialId)
            .map((c) => [c.id, c.phase + ' / ' + c.zone + ' / ' + c.teamName]),
          true,
        )}
        {v.kind === 'transfer' &&
          select(
            'targetProjectId',
            '接收工地',
            projects.filter(([id]) => id !== v.projectId),
          )}
        {select(
          'purchaseId',
          '关联现有采购事项',
          data.purchases.filter((p) => p.projectId === v.projectId).map((p) => [p.id, p.name]),
          true,
        )}
        {input('quantity', '数量/盘点实存（清仓、重开、冲销填0）')}
        {select(
          'inputUnit',
          '录入单位',
          m
            ? [[m.unit, m.unit], ...m.conversions.map((c) => [c.unit, c.unit] as [string, string])]
            : [],
        )}
        {input('unitPrice', '入账单价 元/基准单位（其他操作填0）')}
        {select(
          'referenceId',
          '盘点核销或冲销原流水',
          state.events
            .filter((e) => e.projectId === v.projectId && e.materialId === v.materialId)
            .map((e) => [e.id, '#' + e.seq + ' ' + eventLabels[e.kind] + ' ' + e.date]),
          true,
        )}
        {area('reason', '原始凭据/操作原因（必填）')}
        <p className="form-info span2">
          领用不是使用；只有“确认实际使用”减少班组资产并计入耗量。盘点不自动核销；调拨一条记录同时更新双方，价值按移动加权账面成本转移。实际库存按日期顺序登记。
        </p>
      </>
    );
  }
}
