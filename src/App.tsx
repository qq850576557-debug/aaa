import { useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Archive,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileJson,
  FolderOpen,
  LayoutDashboard,
  Leaf,
  Loader2,
  Package,
  Pin,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  StickyNote,
  TriangleAlert,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { PurchaseCard } from './components/PurchaseCard';
import { PurchaseDeadlineDialog } from './components/PurchaseDeadlineDialog';
import { HistoryPanel, localTime } from './components/HistoryPanel';
import { GLOBAL_SCOPE, workspaceContent, parseArchive, type History } from './lib/history';
import { assignedNames } from './lib/people';
import { PeoplePanel } from './components/PeoplePanel';
import { useCurrentDate } from './lib/useCurrentDate';
import { savePurchase, confirmPurchaseDeadline } from './lib/procurement';
import { Gantt } from './components/Gantt';
import { ProjectCards } from './components/ProjectCards';
import { Confirm, Modal, type Anchor } from './components/Modal';
import { Notifications, useNotices } from './components/Notifications';
import { ColorPopover } from './components/ColorPopover';
import { ScheduleConfirm } from './components/ScheduleConfirm';
import {
  insertTrade,
  proposeTaskChange,
  reorderTrades,
  type ScheduleProposal,
} from './lib/scheduling';
import { Editor, nextTask, type Edit, type Entity } from './components/Forms';
import { useWorkspace } from './lib/useWorkspace';
import { backupJSON } from './lib/export';
import { ExportDialog } from './components/ExportDialog';
import { BRAND_LOGO_SRC, BRAND_NAME, BRAND_INITIALS, BRAND_SLOGAN } from './lib/brand';
import {
  copyProject,
  reorderProjects,
  rememberNames,
  usedNames,
  defaultTrades,
  duration,
  id,
  isHistorical,
  newProject,
  palette,
  parseBackup,
  plus,
  purchaseDue,
  purchaseComplete,
  procurementView,
  projectStatus,
  todayNotes,
  noteDue,
  remainingTime,
  removeProject,
  stats,
  type Data,
  type Project,
  type Trade,
  type Task,
  type Note,
  type Purchase,
} from './lib/model';

type View = 'overview' | 'schedule' | 'notes' | 'purchases' | 'reminders' | 'completed' | 'people';
type Confirmation = { title: string; message: string; run: () => void; danger?: boolean };
const navigation: [View, string, ReactNode][] = [
  ['overview', '项目工作空间', <LayoutDashboard size={19} />],
  ['notes', '事项与备忘', <StickyNote size={19} />],
  ['purchases', '采购管理', <Package size={19} />],
  ['reminders', '提醒中心', <ClipboardList size={19} />],
  ['completed', '已完工项目', <Archive size={19} />],
  ['people', '人员管理', <Users size={19} />],
];
export default function App() {
  const {
    data,
    savedData,
    history,
    historyError,
    ready,
    status,
    error,
    update,
    retry,
    restoreVersion,
  } = useWorkspace();
  const [historyOpen, setHistoryOpen] = useState<{ scope: string; anchor?: Anchor } | null>(null);
  const now = useCurrentDate();
  const [deadlineChange, setDeadlineChange] = useState<string | null>(null);
  const [scheduleProposal, setScheduleProposal] = useState<ScheduleProposal | null>(null);
  const [undo, setUndo] = useState<{ before: Data; label: string } | null>(null);
  const [colorEdit, setColorEdit] = useState<{ id: string; anchor: Anchor } | null>(null);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<View>('overview');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [metricFilter, setMetricFilter] = useState('');
  const [projectStatusFilter, setProjectStatusFilter] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const { notices, notify, dismiss } = useNotices();
  const [exporting, setExporting] = useState(false);
  const [backup, setBackup] = useState(false);
  const [restore, setRestore] = useState<Data | null>(null);
  const [restoreVersions, setRestoreVersions] = useState<History | undefined>(undefined);
  const [restoreError, setRestoreError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const projects = data.projects.filter(
    (p) =>
      (showAllProjects || isHistorical(p) === archived) &&
      (!projectStatusFilter || projectStatus(p.status) === '施工中'),
  );
  const p = projects.find((p) => p.id === selected) ?? projects[0];
  const count = stats(data, now);
  const procurement = procurementView(data, p?.id, now);
  const dailyNotes = todayNotes(data, p?.id, now);
  const projectTasks = data.tasks.filter((t) => t.projectId === p?.id);
  const projectTrades = data.trades
    .filter((t) => t.projectId === p?.id)
    .sort((a, b) => a.order - b.order);
  function mutate(fn: (d: Data) => Data, pid = p?.id) {
    setUndo(null);
    update((d) => {
      const next = fn(d);
      parseBackup(next);
      return {
        ...next,
        projects: next.projects.map((x) =>
          x.id === pid ? { ...x, updatedAt: new Date().toISOString() } : x,
        ),
      };
    });
  }
  function commitSchedule(next: Data, before: Data, label: string) {
    parseBackup(next);
    const stamped = {
      ...next,
      projects: next.projects.map((x) =>
        x.id === p?.id ? { ...x, updatedAt: new Date().toISOString() } : x,
      ),
    };
    update(() => stamped);
    setUndo({ before, label });
    notify(label);
  }
  function changeTask(value: Task) {
    const plan = proposeTaskChange(data, value);
    const prior = data.tasks.find((t) => t.id === value.id);
    const previous =
      prior?.personnel ?? (prior ? { worker: prior.owner, manager: '', designer: '' } : undefined);
    plan.current = rememberNames(plan.current, value.personnel, previous);
    plan.shifted = rememberNames(plan.shifted, value.personnel, previous);
    if (plan.affected.length) {
      setScheduleProposal(plan);
      return;
    }
    commitSchedule(
      plan.current,
      plan.base,
      plan.mergedIds.length
        ? `已合并 ${plan.mergedIds.length + 1} 个相邻任务段，可撤销。`
        : '工期已保存，可撤销。',
    );
  }
  function save(kind: Edit['kind'], value: Entity) {
    if (kind === 'purchase') {
      const purchase = value as Purchase;
      mutate((d) => savePurchase(d, purchase), purchase.projectId);
      return;
    }
    if (kind === 'task') {
      changeTask(value as Task);
      return;
    }

    const pid = kind === 'project' ? value.id : (value as Trade).projectId;
    mutate((base) => {
      const previous =
        kind === 'project'
          ? base.projects.find((x) => x.id === value.id)
          : kind === 'trade'
            ? base.trades.find((x) => x.id === value.id)
            : undefined;
      const d = rememberNames(
        base,
        'personnel' in value ? value.personnel : undefined,
        previous?.personnel ??
          (previous
            ? { worker: '', manager: 'manager' in previous ? previous.manager : '', designer: '' }
            : undefined),
      );
      if (kind === 'project') {
        const v = value as Project;
        const exists = d.projects.some((p) => p.id === v.id);
        return {
          ...d,
          projects: exists ? d.projects.map((p) => (p.id === v.id ? v : p)) : [...d.projects, v],
          trades: exists ? d.trades : [...d.trades, ...defaultTrades(v.id)],
        };
      }
      if (kind === 'trade' && !d.trades.some((t) => t.id === value.id)) {
        const next = insertTrade(d, value as Trade);
        return {
          ...next,
          recentColors: [
            (value as Trade).color,
            ...next.recentColors.filter((c) => c !== (value as Trade).color),
          ].slice(0, 12),
        };
      }
      const key = { trade: 'trades', task: 'tasks', note: 'notes', purchase: 'purchases' }[kind] as
        'trades' | 'tasks' | 'notes' | 'purchases';
      const list = d[key] as Entity[];
      const next = {
        ...d,
        [key]: list.some((x) => x.id === value.id)
          ? list.map((x) => (x.id === value.id ? value : x))
          : [...list, value],
      };
      if (kind === 'trade')
        next.recentColors = [
          (value as Trade).color,
          ...d.recentColors.filter((c) => c !== (value as Trade).color),
        ].slice(0, 12);
      return next;
    }, pid);
    if (kind === 'project') {
      setSelected(pid);
      setArchived(isHistorical(value as Project));
      setView('overview');
    }
  }
  function taskEditor(t?: Task, g?: Trade, start = now, end = start, anchor?: Anchor) {
    if (!p) return;
    const trade = g ?? projectTrades[0];
    if (!trade) {
      notify('请先添加一个工种。');
      return;
    }
    setEdit({
      kind: 'task',
      anchor,
      value: t ?? {
        id: id(),
        projectId: p.id,
        tradeId: trade.id,
        name: trade.name,
        start,
        end,
        owner: '',
        status: '未开始',
        notes: '',
      },
    });
  }
  function tradeEditor(g?: Trade, index = projectTrades.length) {
    if (!p) return;
    const color = palette[projectTrades.length % palette.length];
    setEdit({
      kind: 'trade',
      value: g ?? {
        id: id(),
        projectId: p.id,
        name: '',
        color,
        defaultColor: color,
        order: index,
      },
    });
  }
  function noteEditor(n?: Note, date = day ?? now, memo = false) {
    if (!p) return;
    if (!n && !memo) {
      setDay(null);
      purchaseEditor(undefined, date);
      return;
    }
    setDay(null);
    setEdit({
      kind: 'note',
      value: n ?? {
        id: id(),
        projectId: p.id,
        title: '',
        kind: memo ? '项目备忘' : '施工安排',
        date: memo ? '' : date,
        reminder: '',
        owner: '',
        content: '',
        done: false,
        pinned: false,
      },
    });
  }
  function purchaseEditor(v?: Purchase, date = now) {
    if (!p && !v) return;
    if (v) {
      const project = data.projects.find((x) => x.id === v.projectId);
      if (!project) return;
      setSelected(project.id);
      setArchived(isHistorical(project));
      setProjectStatusFilter(false);
    }
    setDay(null);
    setEdit({
      kind: 'purchase',
      value: v ?? {
        id: id(),
        projectId: p!.id,
        name: '',
        taskId: '',
        due: date,
        leadDays: 0,
        status: '待采购',
        owner: '',
        notes: '',
      },
    });
  }
  function order(g: Trade, dir: number) {
    const pos = projectTrades.findIndex((x) => x.id === g.id);
    const other = projectTrades[pos + dir];
    if (!other) return;
    const sorted = [...projectTrades];
    [sorted[pos], sorted[pos + dir]] = [sorted[pos + dir], sorted[pos]];
    mutate((d) => ({
      ...d,
      trades: d.trades.map((x) =>
        x.projectId === p?.id ? { ...x, order: sorted.findIndex((y) => y.id === x.id) } : x,
      ),
    }));
  }
  function deleteEntity(current = edit) {
    if (!current) return;
    const name = 'name' in current.value ? current.value.name : (current.value as Note).title;
    setConfirmation({
      title: `删除「${name}」？`,
      message:
        current.kind === 'project'
          ? '项目及其工种、施工任务、事项与采购记录都会删除。建议先备份，删除后无法撤销。'
          : current.kind === 'trade'
            ? '该工种及其施工任务将被删除，关联采购将保留当前计算的截止日期。操作无法撤销。'
            : current.kind === 'task'
              ? '该时间条将删除。采购保留当前截止日期并解除关联，事项与备注内容保留，前序引用将清理。操作无法撤销。'
              : '此记录将永久删除。操作无法撤销。',
      run: () => {
        mutate((d) => {
          if (current.kind === 'project') return removeProject(d, current.value.id);
          const removedTasks = d.tasks
            .filter((t) =>
              current.kind === 'task'
                ? t.id === current.value.id
                : current.kind === 'trade' && t.tradeId === current.value.id,
            )
            .map((t) => t.id);
          const next = {
            ...d,
            purchases: d.purchases.map((x) =>
              removedTasks.includes(x.taskId)
                ? { ...x, due: purchaseDue(x, d), taskId: '', deadlineMode: 'fixed' as const }
                : x,
            ),
          };
          if (current.kind === 'trade') {
            next.trades = d.trades.filter((x) => x.id !== current.value.id);
            next.tasks = d.tasks.filter((x) => x.tradeId !== current.value.id);
          }
          if (current.kind === 'task')
            next.tasks = d.tasks.filter((x) => x.id !== current.value.id);
          next.tasks = next.tasks.map((t) => ({
            ...t,
            ...(t.dependsOn
              ? { dependsOn: t.dependsOn.filter((dep) => !removedTasks.includes(dep)) }
              : {}),
          }));
          next.notes = d.notes.map((n) => {
            if (n.taskId && removedTasks.includes(n.taskId)) {
              const { taskId: removed, ...rest } = n;
              void removed;
              return rest;
            }
            return n;
          });
          if (current.kind === 'note')
            next.notes = d.notes.filter((x) => x.id !== current.value.id);
          if (current.kind === 'purchase')
            next.purchases = d.purchases.filter((x) => x.id !== current.value.id);
          return next;
        });
        setEdit(null);
        setConfirmation(null);
      },
    });
  }
  function duplicate() {
    if (!edit) return;
    setUndo(null);
    if (edit.kind === 'project') {
      const source = edit.value;
      update((d) => {
        const result = copyProject(d, source);
        setSelected(result.project.id);
        return result.data;
      });
      setEdit(null);
      notify('项目已复制，任务与采购关联均已保留。');
    } else if (edit.kind === 'task') {
      const value = {
        ...edit.value,
        groupId: undefined,
        id: id(),
        name: `${edit.value.name}（副本）`.slice(0, 100),
      };
      setEdit({ kind: 'task', value });
    }
  }
  function archiveProject() {
    if (!p) return;
    const historical = isHistorical(p);
    setConfirmation({
      title: historical ? '恢复为施工中项目？' : '确认项目已完工？',
      message: historical
        ? '项目将恢复为施工中，原有工期、日期、事项、备忘与采购记录全部保留。'
        : '项目将移入已完工项目区域，保留全部历史记录，并从施工中项目和待办提醒中移除。',
      danger: false,
      run: () => {
        mutate((d) => ({
          ...d,
          projects: d.projects.map((x) =>
            x.id === p.id ? { ...x, status: historical ? '施工中' : '已完工', archived: false } : x,
          ),
        }));
        setArchived(!historical);
        setView(historical ? 'overview' : 'completed');
        setConfirmation(null);
      },
    });
  }
  async function readBackup(file?: File) {
    if (!ready) {
      setRestoreError('请先解决本地读取失败，以保护原有数据。');
      return;
    }
    setRestoreError('');
    if (!file) return;
    if (file.size > 140 * 1024 * 1024) {
      setRestoreError('备份文件不能超过 140 MB');
      return;
    }
    try {
      const archive = parseArchive(JSON.parse(await file.text()));
      setRestore(archive.data);
      setRestoreVersions(archive.history);
    } catch (e) {
      setRestoreError(`备份校验失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  const isExisting =
    edit &&
    {
      project: data.projects,
      trade: data.trades,
      task: data.tasks,
      note: data.notes,
      purchase: data.purchases,
    }[edit.kind].some((x) => x.id === edit.value.id);
  const matchingNotes = data.notes
    .filter(
      (n) =>
        n.projectId === p?.id &&
        (!onlyOpen || !n.done) &&
        `${n.title} ${n.content} ${n.owner}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(a.done) - Number(b.done) ||
        a.date.localeCompare(b.date),
    );
  const projectPurchases = procurement.all
    .filter(
      (x) =>
        x.projectId === p?.id &&
        (!onlyOpen || !purchaseComplete(x)) &&
        `${x.name} ${x.notes} ${x.owner} ${x.quantity ?? ''} ${x.specification ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => purchaseDue(a, data).localeCompare(purchaseDue(b, data)));
  function purchaseCard(x: Purchase) {
    return (
      <PurchaseCard
        key={x.id}
        purchase={x}
        data={data}
        now={now}
        onEdit={() => purchaseEditor(x)}
        onStatus={(status) => save('purchase', { ...x, due: purchaseDue(x, data), status })}
      />
    );
  }
  function go(v: View) {
    setView(v);
    if (v === 'completed') {
      setArchived(true);
      setSelected('');
    } else if (v === 'overview') {
      setArchived(false);
      setSelected('');
    }
    setSearch('');
    setOnlyOpen(false);
    setMetricFilter('');
    setShowAllProjects(false);
    setProjectStatusFilter(false);
  }
  function reminderItems() {
    const active = new Set(data.projects.filter((p) => !isHistorical(p)).map((p) => p.id));
    return (
      <div className="reminder-columns" data-filter={metricFilter}>
        {metricFilter && (
          <div className="project-filter">
            正在查看：{metricFilter}
            <button className="text-btn" onClick={() => setMetricFilter('')}>
              查看全部提醒
            </button>
          </div>
        )}
        <div className="panel" hidden={!!metricFilter && metricFilter !== '已逾期施工'}>
          <h3>
            <TriangleAlert size={18} />
            逾期施工
          </h3>
          {data.tasks
            .filter((t) => active.has(t.projectId) && t.status !== '已完成' && t.end < now)
            .map((t) => (
              <button
                className="reminder-item"
                key={t.id}
                onClick={() => {
                  setSelected(t.projectId);
                  setArchived(false);
                  setEdit({ kind: 'task', value: t });
                }}
              >
                <span>
                  <strong>{t.name}</strong>
                  <small>{data.projects.find((x) => x.id === t.projectId)?.name}</small>
                </span>
                <em>{t.end} 到期</em>
              </button>
            ))}
          {count.overdueTasks === 0 && (
            <Empty small title="没有逾期施工" text="按计划推进，让每一步都有条不紊。" />
          )}
        </div>
        <div
          className="panel"
          hidden={
            !!metricFilter && !['未来 15 天采购', '已逾期采购', '今日待办'].includes(metricFilter)
          }
        >
          <h3>
            <Package size={18} />
            采购提醒 · 未来 15 天及逾期
          </h3>
          {data.purchases
            .filter(
              (x) =>
                active.has(x.projectId) &&
                !purchaseComplete(x) &&
                purchaseDue(x, data) <= plus(now, 15) &&
                (!metricFilter ||
                  (metricFilter === '今日待办'
                    ? purchaseDue(x, data) <= now
                    : metricFilter === '已逾期采购'
                      ? purchaseDue(x, data) < now
                      : purchaseDue(x, data) >= now)),
            )
            .map(purchaseCard)}
          {count.upcoming + count.overduePurchases === 0 && (
            <Empty small title="暂无采购提醒" text="创建采购记录后，提醒会出现在这里。" />
          )}
        </div>
        <div className="panel" hidden={!!metricFilter && metricFilter !== '今日待办'}>
          <h3>
            <ClipboardList size={18} />
            事项提醒 · 今日及逾期
          </h3>
          {todayNotes(data, undefined, now)
            .filter((n) => active.has(n.projectId) && !n.done)
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((n) => (
              <button
                className="reminder-item"
                key={n.id}
                onClick={() => {
                  setSelected(n.projectId);
                  setArchived(false);
                  setEdit({ kind: 'note', value: n });
                }}
              >
                <span>
                  <strong>{n.title}</strong>
                  <small>{data.projects.find((x) => x.id === n.projectId)?.name}</small>
                </span>
                <em>
                  {noteDue(n)} · {remainingTime(noteDue(n), now)}
                </em>
              </button>
            ))}
        </div>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go('overview');
          }}
        >
          {BRAND_LOGO_SRC && <img src={BRAND_LOGO_SRC} alt="春茉空间设计原始 Logo" />}
          <div>
            <strong className="brand-name">{BRAND_NAME}</strong>
            <span className="brand-initials">{BRAND_INITIALS}</span>
            <span className="brand-slogan">{BRAND_SLOGAN}</span>
          </div>
        </a>
        <div className="sidebar-section">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav>
          {navigation.map(([key, label, icon]) => (
            <button key={key} className={view === key ? 'active' : ''} onClick={() => go(key)}>
              {icon}
              <span>{label}</span>
              {key === 'reminders' && count.overduePurchases + count.overdueTasks > 0 && (
                <b>{count.overduePurchases + count.overdueTasks}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            disabled={!ready}
            onClick={() =>
              setHistoryOpen({ scope: view === 'people' ? GLOBAL_SCOPE : (p?.id ?? GLOBAL_SCOPE) })
            }
          >
            版本历史 · 15天
          </button>
          <button onClick={() => setBackup(true)}>
            <ShieldCheck size={17} />
            数据与备份
            <ArrowRight size={15} />
          </button>
          <p>
            本地工作空间 <i />
          </p>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="mobile-brand">
            <strong className="brand-name">{BRAND_NAME}</strong>
            <span className="brand-initials">{BRAND_INITIALS}</span>
          </div>
          <div className="breadcrumb">
            工作空间 <span>/</span>
            <strong>{navigation.find((x) => x[0] === view)?.[1]}</strong>
          </div>
          {p && (
            <div className="active-project" title={`${p.name} · ${projectStatus(p.status)}`}>
              <strong>{p.name}</strong>
              <span>{projectStatus(p.status)}</span>
            </div>
          )}
          <div className={`save-state ${status.includes('失败') ? 'red' : ''}`} role="status">
            {status === '正在保存' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            <span>{status}</span>
            <div className="avatar">春</div>
          </div>
        </header>
        <main>
          {undo && (
            <div className="undo-banner">
              <span>{undo.label}</span>
              <button
                onClick={() => {
                  update(() => undo.before);
                  setUndo(null);
                  notify('已撤销上一次工期或排序调整。');
                }}
              >
                撤销
              </button>
              <button aria-label="关闭撤销提示" onClick={() => setUndo(null)}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="local-notice">
            <ShieldCheck size={15} />
            <span>本地模式 · 数据仅保存在当前浏览器和设备，不会自动同步。建议定期备份。</span>
            <button onClick={() => setBackup(true)} disabled={!ready}>
              备份数据
              <ArrowDownToLine size={13} />
            </button>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={18} />
              <span>{error}</span>
              {ready ? (
                <>
                  <button onClick={() => void retry()}>重试保存</button>
                  <button onClick={() => backupJSON(data)}>紧急备份</button>
                </>
              ) : (
                <button onClick={() => window.location.reload()}>重新读取</button>
              )}
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">RENOVATION WORKSPACE</div>
              <h1>
                {view === 'overview'
                  ? '项目工作空间'
                  : view === 'schedule'
                    ? '施工计划'
                    : view === 'notes'
                      ? '每日事项与项目备忘'
                      : view === 'purchases'
                        ? '材料采购管理'
                        : view === 'completed'
                          ? '已完工项目'
                          : view === 'people'
                            ? '人员管理'
                            : '项目提醒中心'}
              </h1>
              <p>
                {view === 'overview'
                  ? '工期有序，细节有据。从设计到落地，悉心照料每一个家。'
                  : view === 'schedule'
                    ? '以清晰的时间线，串联每一道施工工序。'
                    : view === 'notes'
                      ? '记录现场的每个细节，让重要的事不再遗漏。'
                      : view === 'purchases'
                        ? '把材料安排在施工之前，让进度从容向前。'
                        : view === 'people'
                          ? '统一管理人员档案与项目分配。'
                          : '及时关注待办与风险，让计划保持在轨道上。'}
              </p>
            </div>
            <div className="heading-actions">
              {(view === 'overview' || view === 'completed') && (
                <button
                  className="primary"
                  onClick={() => setEdit({ kind: 'project', value: newProject() })}
                  disabled={!ready}
                >
                  <Plus size={17} />
                  新建项目
                </button>
              )}
            </div>
          </div>
          <div className="stats-grid">
            {(
              [
                {
                  label: '项目总数',
                  value: count.total,
                  unit: '个项目',
                  icon: <FolderOpen />,
                  target: 'overview',
                },
                {
                  label: '施工中的项目',
                  value: count.ongoing,
                  unit: '正在推进',
                  icon: <CalendarDays />,
                  target: 'overview',
                },
                {
                  label: '今日待办',
                  value: count.todos,
                  unit: '条待处理',
                  icon: <ClipboardList />,
                  target: 'reminders',
                },
                {
                  label: '未来 15 天采购',
                  value: count.upcoming,
                  unit: '项需提前准备',
                  icon: <Package />,
                  target: 'reminders',
                },
                {
                  label: '已逾期采购',
                  value: count.overduePurchases,
                  unit: '项需要关注',
                  icon: <TriangleAlert />,
                  target: 'reminders',
                },
                {
                  label: '已逾期施工',
                  value: count.overdueTasks,
                  unit: '段需要跟进',
                  icon: <CalendarDays />,
                  target: 'reminders',
                },
              ] as const
            ).map((s, i) => (
              <button
                key={s.label}
                className={`stat-card ${i >= 4 && s.value > 0 ? 'attention' : ''}`}
                onClick={() => {
                  go(s.target);
                  if (s.label === '项目总数') setShowAllProjects(true);
                  if (s.label === '施工中的项目') setProjectStatusFilter(true);
                  else setProjectStatusFilter(false);
                  if (s.target === 'reminders') setMetricFilter(s.label);
                }}
              >
                <div>
                  <span>{s.label}</span>
                  {s.icon}
                </div>
                <strong>{s.value > 0 ? s.value : '暂无'}</strong>
                <small>{s.unit}</small>
              </button>
            ))}
          </div>
          {!ready && !error ? (
            <div className="loading">
              <Loader2 className="spin" />
              正在读取你的工作空间…
            </div>
          ) : view === 'reminders' ? (
            reminderItems()
          ) : view === 'people' ? (
            <PeoplePanel data={data} onChange={(fn) => mutate(fn)} />
          ) : (
            <>
              {projectStatusFilter && (
                <div className="project-filter">
                  仅显示施工中的项目
                  <button className="text-btn" onClick={() => setProjectStatusFilter(false)}>
                    查看全部项目
                  </button>
                </div>
              )}
              <div className="project-toolbar">
                <div className="project-switch">
                  <FolderOpen size={18} />
                  <select
                    aria-label="切换项目"
                    value={p?.id ?? ''}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {!projects.length && (
                      <option value="">{archived ? '暂无已完工项目' : '选择一个项目'}</option>
                    )}
                    {projects.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
                <div className="toolbar">
                  {p && (
                    <>
                      <button
                        aria-label="编辑当前项目"
                        onClick={() => setEdit({ kind: 'project', value: p })}
                      >
                        <Settings2 size={15} />
                        <span>项目设置</span>
                      </button>
                      <button onClick={archiveProject}>
                        <Archive size={15} />
                        {isHistorical(p) ? '恢复施工中' : '标记完工'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {!p ? (
                <Empty
                  title={archived ? '暂无已完工项目' : '一个理想的家，从一份好计划开始。'}
                  text={
                    archived
                      ? '完成后的项目会完整保留，也可随时恢复为施工中。'
                      : '新建第一个项目，安排工期、记录事项，让每个施工细节井然有序。'
                  }
                  action={
                    !archived ? (
                      <button
                        className="primary"
                        onClick={() => setEdit({ kind: 'project', value: newProject() })}
                      >
                        <Plus size={17} />
                        创建第一个项目
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  {(view === 'overview' || view === 'completed') && (
                    <section className="recent-section">
                      <div className="section-heading">
                        <h2>
                          {archived ? '已完工项目' : '项目列表 · 拖动排序'}{' '}
                          <span className="count">{projects.length}</span>
                        </h2>
                      </div>
                      <ProjectCards
                        data={data}
                        projects={projects}
                        selected={p.id}
                        onSelect={setSelected}
                        onReorder={(source, before) =>
                          commitSchedule(
                            reorderProjects(
                              data,
                              source,
                              before,
                              projects.map((x) => x.id),
                            ),
                            data,
                            '项目顺序已保存，可撤销。',
                          )
                        }
                      />
                    </section>
                  )}
                  <section className="project-summary">
                    <div className="project-emblem">
                      <Leaf size={32} />
                    </div>
                    <div className="project-info">
                      <div>
                        <span className="project-status">
                          {projectStatus(p.status)}
                          {p.archived ? ' · 原归档记录' : ''}
                        </span>
                        <span className="project-code">
                          PROJECT / {data.projects.findIndex((x) => x.id === p.id) + 1}
                        </span>
                      </div>
                      <h2>{p.name}</h2>
                      <div className="project-history-entry">
                        <button
                          disabled={!ready}
                          onClick={(e) =>
                            setHistoryOpen({
                              scope: p.id,
                              anchor: { x: e.clientX, y: e.clientY, element: e.currentTarget },
                            })
                          }
                        >
                          最后修改：
                          {savedData.projects.find((x) => x.id === p.id)?.updatedAt
                            ? localTime(savedData.projects.find((x) => x.id === p.id)!.updatedAt)
                            : '等待首次保存'}{' '}
                          <ChevronDown size={14} />
                        </button>
                      </div>
                      {(assignedNames(data, p, '设计人员') || assignedNames(data, p, '监理')) && (
                        <p className="project-team">
                          {[
                            assignedNames(data, p, '设计人员') &&
                              `设计团队：${assignedNames(data, p, '设计人员')}`,
                            assignedNames(data, p, '监理') &&
                              `监理：${assignedNames(data, p, '监理')}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                      <p>
                        {[
                          p.address,
                          p.owner && `${p.owner} · 业主`,
                          p.manager && `${p.manager} · 负责人`,
                        ]
                          .filter(Boolean)
                          .join('　/　')}
                      </p>
                    </div>
                    <div className="project-dates">
                      <span>
                        计划开工 <strong>{p.start}</strong>
                      </span>
                      <ArrowRight size={17} />
                      <span>
                        计划完工 <strong>{p.end}</strong>
                      </span>
                    </div>
                    <div className="project-days">
                      <strong>
                        {duration(p.start, p.end)}
                        <small>天</small>
                      </strong>
                      <span>计划总工期 · 自然日</span>
                    </div>
                  </section>
                  <nav className="workspace-anchors" aria-label="当前项目分区">
                    <a href="#project-today">今日事项与备忘</a>
                    <a href="#project-procurement">采购与风险</a>
                    <a href="#project-timeline">施工时间轴</a>
                  </nav>
                  {(view === 'overview' || view === 'schedule' || view === 'completed') && (
                    <div className="lower-grid" id="project-today">
                      <section className="panel" data-testid="today-panel">
                        <div className="section-heading">
                          <h2>
                            今日事项{' '}
                            <span className="count">
                              {procurement.today.length + dailyNotes.filter((n) => !n.done).length}
                            </span>
                          </h2>
                          <button className="text-btn" onClick={() => noteEditor()}>
                            <Plus size={15} />
                            添加采购事项
                          </button>
                        </div>
                        <p className="today-summary">
                          {procurement.today.length + dailyNotes.filter((n) => !n.done).length}{' '}
                          条待处理 · 包含逾期采购，完成后不再重复提醒
                        </p>
                        {procurement.today.map(purchaseCard)}
                        {dailyNotes.map((n) => (
                          <NoteCard
                            key={n.id}
                            note={n}
                            onEdit={() => noteEditor(n)}
                            onToggle={() => save('note', { ...n, done: !n.done })}
                            onPin={() => save('note', { ...n, pinned: !n.pinned })}
                          />
                        ))}
                        {!procurement.today.length && !dailyNotes.length && (
                          <Empty
                            small
                            title="今天暂时没有事项"
                            text="今天到期或逾期的未完成采购将在此自动显示。"
                          />
                        )}
                      </section>
                      <section className="panel memo-panel">
                        <div className="section-heading">
                          <h2>项目备忘</h2>
                          <button
                            className="text-btn"
                            onClick={() => noteEditor(undefined, '', true)}
                          >
                            <Plus size={15} />
                            添加
                          </button>
                        </div>
                        {data.notes
                          .filter((n) => n.projectId === p.id && n.kind === '项目备忘')
                          .sort((a, b) => Number(b.pinned) - Number(a.pinned))
                          .slice(0, 3)
                          .map((n) => (
                            <NoteCard
                              key={n.id}
                              note={n}
                              onEdit={() => noteEditor(n)}
                              onToggle={() => save('note', { ...n, done: !n.done })}
                              onPin={() => save('note', { ...n, pinned: !n.pinned })}
                            />
                          ))}
                        {!data.notes.some((n) => n.projectId === p.id && n.kind === '项目备忘') && (
                          <Empty
                            small
                            title="好设计，藏在被记住的细节里。"
                            text="记录业主要求、材料信息与现场注意事项。"
                          />
                        )}
                        <button className="text-btn" onClick={() => go('notes')}>
                          查看全部事项与备忘
                          <ArrowRight size={14} />
                        </button>
                      </section>
                    </div>
                  )}
                  {(view === 'overview' || view === 'schedule' || view === 'completed') && (
                    <div className="project-alerts" id="project-procurement">
                      <section className="panel" data-testid="upcoming-panel">
                        <h3>未来 15 天采购</h3>
                        {procurement.upcoming.map(purchaseCard)}
                        {!procurement.upcoming.length && (
                          <p className="muted">暂无未来 15 天采购安排。</p>
                        )}
                        <button className="text-btn" onClick={() => purchaseEditor()}>
                          <Plus size={15} />
                          添加采购
                        </button>
                      </section>
                      <section className="panel">
                        <h3>逾期提醒</h3>
                        {procurement.overdue.map(purchaseCard)}
                        {projectTasks
                          .filter((t) => t.status !== '已完成' && t.end < now)
                          .map((t) => (
                            <button
                              key={t.id}
                              className="reminder-item"
                              onClick={() => taskEditor(t)}
                            >
                              <strong>{t.name} · 施工逾期</strong>
                              <em>{t.end}</em>
                            </button>
                          ))}
                        {!projectPurchases.some(
                          (x) => !purchaseComplete(x) && purchaseDue(x, data) < now,
                        ) &&
                          !projectTasks.some((t) => t.status !== '已完成' && t.end < now) && (
                            <p className="muted">暂无逾期采购或施工任务。</p>
                          )}
                      </section>
                    </div>
                  )}
                  {(view === 'overview' || view === 'schedule' || view === 'completed') && (
                    <Gantt
                      key={p.id}
                      data={data}
                      project={p}
                      onTask={taskEditor}
                      onDeleteTask={(t) => deleteEntity({ kind: 'task', value: t })}
                      onQuickCreate={(_g, date) => purchaseEditor(undefined, date)}
                      onExport={() => setExporting(true)}
                      onDay={setDay}
                      onTrade={tradeEditor}
                      onOrder={order}
                      onReorder={(source, before) => {
                        if (!p) return;
                        commitSchedule(
                          reorderTrades(data, p.id, source, before),
                          data,
                          '工种顺序已保存，任务日期保持不变。',
                        );
                      }}
                      onColor={(g, anchor) => setColorEdit({ id: g.id, anchor })}
                      onMove={(t) => {
                        try {
                          changeTask(t);
                        } catch (e) {
                          notify(`工期调整失败：${e instanceof Error ? e.message : String(e)}`);
                        }
                      }}
                    />
                  )}
                  {(view === 'notes' || view === 'purchases') && (
                    <section className="records-section">
                      <div className="section-heading">
                        <h2>
                          {view === 'notes' ? '事项与备忘' : '采购清单'}{' '}
                          <span className="count">
                            {view === 'notes'
                              ? matchingNotes.length + projectPurchases.length
                              : projectPurchases.length}{' '}
                            条记录
                          </span>
                        </h2>
                        <div className="toolbar">
                          {view === 'notes' && (
                            <button onClick={() => noteEditor(undefined, '', true)}>
                              <Plus size={15} />
                              项目备忘
                            </button>
                          )}
                          <button
                            className="primary"
                            onClick={() => (view === 'notes' ? noteEditor() : purchaseEditor())}
                          >
                            <Plus size={15} />
                            {view === 'notes' ? '新增事项' : '新增采购'}
                          </button>
                        </div>
                      </div>
                      <div className="filter-row">
                        <div className="search-field">
                          <Search size={16} />
                          <input
                            placeholder={
                              view === 'notes'
                                ? '搜索标题、内容或负责人…'
                                : '搜索材料、规格或负责人…'
                            }
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                          />
                        </div>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={onlyOpen}
                            onChange={(e) => setOnlyOpen(e.target.checked)}
                          />
                          只看未完成
                        </label>
                      </div>
                      {view === 'notes' ? (
                        <div className="notes-grid">
                          {projectPurchases.map(purchaseCard)}
                          {matchingNotes.map((n) => (
                            <NoteCard
                              key={n.id}
                              note={n}
                              onEdit={() => noteEditor(n)}
                              onToggle={() => save('note', { ...n, done: !n.done })}
                              onPin={() => save('note', { ...n, pinned: !n.pinned })}
                            />
                          ))}
                          {!matchingNotes.length && !projectPurchases.length && (
                            <Empty
                              small
                              title="暂无匹配事项"
                              text="添加一条事项或项目备忘，把重要细节记录下来。"
                            />
                          )}
                        </div>
                      ) : (
                        <div className="purchase-list">
                          {projectPurchases.map(purchaseCard)}
                          {!projectPurchases.length && (
                            <Empty
                              small
                              title="采购清单还是空的"
                              text="添加材料并关联施工任务，提前安排到货时间。"
                            />
                          )}
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>SJD · 春茉空间设计</span>

            <span>本地存储 · 不自动同步</span>
          </footer>
        </main>
      </div>
      <Notifications notices={notices} onDismiss={dismiss} />
      {edit && (
        <Editor
          key={`${edit.kind}-${edit.value.id}`}
          edit={edit}
          onForgetName={(name) => {
            const projectsUsing = data.projects.filter(
              (project) =>
                project.manager === name ||
                Object.values(project.personnel ?? {}).includes(name) ||
                [...data.trades, ...data.tasks].some(
                  (x) =>
                    x.projectId === project.id &&
                    (Object.values(x.personnel ?? {}).includes(name) ||
                      ('owner' in x && x.owner === name)),
                ),
            );
            setConfirmation({
              title: '删除历史姓名？',
              message: `${name}${
                projectsUsing.length
                  ? `正在 ${projectsUsing.length} 个项目中使用（${projectsUsing
                      .slice(0, 3)
                      .map((x) => x.name)
                      .join('、')}）。`
                  : '暂无项目使用。'
              }仅移出历史候选库，不修改任何人员登记或施工记录。`,
              run: () => {
                mutate((d) => ({
                  ...d,
                  nameHistory: (d.nameHistory ?? usedNames(d)).filter((n) => n !== name),
                }));
                setConfirmation(null);
                notify('历史姓名已移除，已有登记保持完整。');
              },
            });
          }}
          data={data}
          onDeadlineChange={(p) => setDeadlineChange(p.id)}
          onClose={() => setEdit(null)}
          onSave={save}
          onDelete={isExisting ? () => deleteEntity() : undefined}
          onCopy={
            isExisting && (edit.kind === 'task' || edit.kind === 'project') ? duplicate : undefined
          }
          onContinue={(t) =>
            setEdit({
              kind: 'task',
              value: { ...nextTask(t), id: id(), groupId: t.groupId ?? t.id },
            })
          }
          onSegment={(t) =>
            setEdit({
              kind: 'task',
              value: { ...nextTask(t), id: id(), groupId: t.groupId ?? t.id },
            })
          }
        />
      )}
      {historyOpen && (
        <HistoryPanel
          data={data}
          history={history}
          scope={historyOpen.scope}
          anchor={historyOpen.anchor}
          error={historyError}
          canRestore={status === '已保存'}
          onClose={() => setHistoryOpen(null)}
          onRestore={async (revision) => {
            await restoreVersion(revision);
            setUndo(null);
            setEdit(null);
            setDay(null);
            setScheduleProposal(null);
            setColorEdit(null);
            notify('版本恢复已保存，相关工期与采购提醒已重新计算。');
          }}
        />
      )}
      {day && p && (
        <Modal
          title={`${day} · 每日事项`}
          subtitle={`${p.name} / 施工、采购与现场安排`}
          onClose={() => setDay(null)}
          wide
        >
          <div className="modal-body day-content">
            <h3>施工安排</h3>
            {projectTasks
              .filter((t) => t.start <= day && t.end >= day)
              .map((t) => (
                <button
                  key={t.id}
                  className="day-task"
                  onClick={() => {
                    setDay(null);
                    taskEditor(t);
                  }}
                >
                  <i style={{ background: projectTrades.find((g) => g.id === t.tradeId)?.color }} />
                  <strong>{t.name}</strong>
                  <span>
                    {t.status} · {t.owner || '未指定负责人'}
                  </span>
                </button>
              ))}
            {!projectTasks.some((t) => t.start <= day && t.end >= day) && (
              <p className="muted">当天暂无施工任务。</p>
            )}
            <h3>当日事项与提醒</h3>
            {data.notes
              .filter((n) => n.projectId === p.id && (n.date === day || n.reminder === day))
              .map((n) => (
                <NoteCard
                  key={n.id}
                  note={n}
                  onEdit={() => noteEditor(n)}
                  onToggle={() => save('note', { ...n, done: !n.done })}
                  onPin={() => save('note', { ...n, pinned: !n.pinned })}
                />
              ))}
            <h3>采购截止</h3>
            {data.purchases
              .filter(
                (x) => x.projectId === p.id && !purchaseComplete(x) && purchaseDue(x, data) === day,
              )
              .map(purchaseCard)}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setDay(null)}>关闭</button>
            <button className="primary" onClick={() => noteEditor(undefined, day)}>
              <Plus size={15} />
              新增当天事项
            </button>
          </footer>
        </Modal>
      )}
      {backup && (
        <Modal
          title="数据与备份"
          subtitle="你的项目，值得被妥善保存。"
          onClose={() => {
            setBackup(false);
            setRestoreError('');
          }}
        >
          <div className="modal-body backup-body">
            <div className="backup-notice">
              <ShieldCheck size={26} />
              <p>
                数据保存在当前浏览器的 IndexedDB
                中。清除网站数据、切换浏览器或设备会导致无法访问这些记录。请将 JSON 备份妥善保存。
              </p>
            </div>
            <button
              className="backup-action"
              disabled={status !== '已保存' || !!historyError}
              onClick={() => {
                backupJSON(savedData, history);
                notify('业务与最近15天版本备份已下载。');
              }}
            >
              下载业务与版本备份
            </button>
            <button
              className="backup-action"
              onClick={() => {
                backupJSON(data);
                notify('完整 JSON 备份已下载。');
              }}
            >
              <FileJson size={24} />
              <span>
                <strong>下载完整 JSON 备份</strong>
                <small>
                  {data.projects.length} 个项目 · {data.tasks.length} 段施工 · 包含所有事项和采购
                </small>
              </span>
              <ArrowDownToLine size={19} />
            </button>
            <button className="backup-action" onClick={() => fileRef.current?.click()}>
              <Upload size={24} />
              <span>
                <strong>从 JSON 备份恢复</strong>
                <small>先校验文件，再确认替换所有本地数据</small>
              </span>
              <ArrowRight size={19} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => void readBackup(e.target.files?.[0])}
            />
            {restoreError && (
              <p className="error" role="alert">
                {restoreError}
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setBackup(false)}>关闭</button>
          </footer>
        </Modal>
      )}
      {restore && (
        <Confirm
          title="覆盖当前全部项目数据？"
          message={`备份校验通过：${restore.projects.length} 个项目、${restore.tasks.length} 段任务、${restore.notes.length} 条事项、${restore.purchases.length} 条采购。确认后将替换全部本地数据。请先下载当前备份。`}
          onCancel={() => setRestore(null)}
          onConfirm={() => {
            setUndo(null);
            update(() => restore, { history: restoreVersions, source: 'JSON备份恢复' });
            setRestore(null);
            setBackup(false);
            setSelected('');
            setArchived(false);
            setView('overview');
            notify('备份已载入，正在保存到当前浏览器。');
          }}
        />
      )}
      {exporting && p && (
        <ExportDialog
          data={data}
          project={p}
          onClose={() => setExporting(false)}
          onNotice={notify}
        />
      )}
      {colorEdit && data.trades.find((g) => g.id === colorEdit.id) && (
        <ColorPopover
          trade={data.trades.find((g) => g.id === colorEdit.id)!}
          recent={data.recentColors}
          anchor={colorEdit.anchor}
          onChange={(color) =>
            save('trade', { ...data.trades.find((g) => g.id === colorEdit.id)!, color })
          }
          onClose={() => setColorEdit(null)}
        />
      )}
      {scheduleProposal && (
        <ScheduleConfirm
          proposal={scheduleProposal}
          onCancel={() => {
            setScheduleProposal(null);
            notify('已取消工期调整，所有日期保持不变。');
          }}
          onApply={(shift) => {
            if (workspaceContent(data) !== workspaceContent(scheduleProposal.base)) {
              setScheduleProposal(null);
              notify('无法应用过期预览：数据已变化，请重新调整工期。');
              return;
            }
            commitSchedule(
              shift ? scheduleProposal.shifted : scheduleProposal.current,
              scheduleProposal.base,
              shift ? '后续工期已顺延，可撤销。' : '已仅调整当前工序，可撤销。',
            );
            setScheduleProposal(null);
          }}
        />
      )}
      {deadlineChange && data.purchases.find((x) => x.id === deadlineChange) && (
        <PurchaseDeadlineDialog
          purchase={data.purchases.find((x) => x.id === deadlineChange)!}
          data={data}
          onClose={() => setDeadlineChange(null)}
          onConfirm={(date, reason) => {
            mutate((d) => confirmPurchaseDeadline(d, deadlineChange, date, reason));
            setDeadlineChange(null);
            setEdit(null);
            notify('采购期限已明确变更，原始截止和原因已保留。');
          }}
        />
      )}
      {confirmation && (
        <Confirm
          title={confirmation.title}
          message={confirmation.message}
          danger={confirmation.danger ?? true}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmation.run}
        />
      )}
    </div>
  );
}
function Empty({
  title,
  text,
  action,
  small = false,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className={`empty-state ${small ? 'small' : ''}`}>
      <div className="empty-icon">
        <Leaf size={small ? 22 : 32} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function NoteCard({
  note: n,
  onEdit,
  onToggle,
  onPin,
}: {
  note: Note;
  onEdit: () => void;
  onToggle: () => void;
  onPin: () => void;
}) {
  return (
    <article className={`note-card ${n.done ? 'done' : ''}`}>
      <button
        className={`todo-check ${n.done ? 'checked' : ''}`}
        aria-label={`${n.done ? '标记未完成' : '完成'}${n.title}`}
        onClick={onToggle}
      >
        {n.done && <Check size={13} />}
      </button>
      <button className="note-main" onClick={onEdit}>
        <span className="note-kind">
          {n.kind} {n.date && `· ${n.date}`}{' '}
          {noteDue(n) && !n.done && `· ${remainingTime(noteDue(n))}`}
        </span>
        <h3>{n.title}</h3>
        {n.content && <p>{n.content}</p>}
        <small>
          {n.owner || '未指定负责人'}
          {n.reminder && ` · 提醒 ${n.reminder}`}
        </small>
      </button>
      <button
        className={`pin-btn ${n.pinned ? 'pinned' : ''}`}
        aria-label={`${n.pinned ? '取消置顶' : '置顶'}${n.title}`}
        onClick={onPin}
      >
        <Pin size={15} />
      </button>
    </article>
  );
}
