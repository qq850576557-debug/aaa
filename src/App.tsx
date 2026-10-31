import { ThemedWorkspace } from './components/ProjectThemes';
import { WorkspaceSaveConflict } from './components/WorkspaceSaveConflict';
import { DeferredPanel } from './components/ModuleBoundary';
import { mergeWorkspace } from './lib/workspace-merge';
import { BriefPanel } from './components/BriefPanel';
import { ProjectContext } from './components/ProjectContext';
import { categorizedAgenda, type AgendaItem as AgendaEntry } from './lib/agenda';
import { AgendaItem } from './components/AgendaItem';
import { useWorkRecords } from './lib/useWorkRecords';
import type { WorkRecord } from './lib/records';
import type { AgendaEntryRequest } from './components/AgendaEntryDialog';
import type { CloudUser } from './lib/cloud';
import {
  nextTradeColor,
  saveTradeColor,
  newProjectTrades,
  initialStageColor,
  defaultTradeColor,
} from './lib/trade-colors';
import { CloudControl } from './components/CloudControl';
import { ConflictPanel } from './components/ConflictPanel';
import { scheduleForecast } from './lib/readiness';
import { CollaborationBar } from './components/CollaborationBar';
import { lazy, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Archive,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardList,
  FileJson,
  FolderOpen,
  LayoutDashboard,
  KanbanSquare,
  History as HistoryIcon,
  Leaf,
  Loader2,
  Package,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { PurchaseCard } from './components/PurchaseCard';
import { PurchaseDeadlineDialog } from './components/PurchaseDeadlineDialog';
import { HistoryPanel } from './components/HistoryPanel';
import { GLOBAL_SCOPE, workspaceContent, parseArchive, type History } from './lib/history';
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
  proposeTaskChanges,
  reorderTrades,
  type ScheduleProposal,
} from './lib/scheduling';
import { Editor, nextTask, type Edit, type Entity } from './components/Forms';
import { useWorkspace } from './lib/useWorkspaceMode';
import { backupJSON, downloadBlob } from './lib/export';
import { ExportDialog } from './components/ExportDialog';
import { BRAND_LOGO_SRC, BRAND_NAME, BRAND_SLOGAN } from './lib/brand';
import {
  copyProject,
  reorderProjects,
  rememberNames,
  usedNames,
  id,
  isHistorical,
  newProject,
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

type View =
  | 'overview'
  | 'schedule'
  | 'purchases'
  | 'reminders'
  | 'completed'
  | 'people'
  | 'materials'
  | 'records';
type Confirmation = { title: string; message: string; run: () => void; danger?: boolean };
const navigation: [View, string, ReactNode][] = [
  ['overview', '项目工作空间', <LayoutDashboard size={19} />],
  ['records', '事项管理', <KanbanSquare size={19} />],
  ['purchases', '采购管理', <Package size={19} />],
  ['reminders', '提醒中心', <ClipboardList size={19} />],
  ['completed', '已完工项目', <Archive size={19} />],
  ['people', '人员管理', <Users size={19} />],
];
const RecordBoard = lazy(() =>
  import('./components/RecordBoard').then((m) => ({ default: m.RecordBoard })),
);
const MaterialsPanel = lazy(() =>
  import('./components/MaterialsPanel').then((m) => ({ default: m.MaterialsPanel })),
);
const MaterialAlertSummary = lazy(() =>
  import('./components/MaterialsPanel').then((m) => ({ default: m.MaterialAlertSummary })),
);
const PeoplePanel = lazy(() =>
  import('./components/PeoplePanel').then((m) => ({ default: m.PeoplePanel })),
);
const AgendaEntryDialog = lazy(() =>
  import('./components/AgendaEntryDialog').then((m) => ({ default: m.AgendaEntryDialog })),
);
const RecordDrawer = lazy(() =>
  import('./components/RecordDrawer').then((m) => ({ default: m.RecordDrawer })),
);
export default function App({ initialUser }: { initialUser?: CloudUser }) {
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
    isCloud,
    cloudUser,
    reloadCloud,
    changeDeadline,
    hasUnsavedChanges,
    saveConflict,
    resolveSaveConflict,
    dismissSaveConflict,
    draftRecoveryNotice,
    draftRecoveryPackage,
  } = useWorkspace(initialUser);
  const [historyOpen, setHistoryOpen] = useState<{ scope: string; anchor?: Anchor } | null>(null);
  const [navExpanded, setNavExpanded] = useState(() => {
    try {
      return localStorage.getItem('chunmo-local-navigation') !== 'collapsed';
    } catch {
      return true;
    }
  });
  function toggleNavigation() {
    setNavExpanded((v) => {
      try {
        localStorage.setItem('chunmo-local-navigation', v ? 'collapsed' : 'expanded');
      } catch {
        /* browser storage unavailable */
      }
      return !v;
    });
  }
  const now = useCurrentDate();
  const [deadlineChange, setDeadlineChange] = useState<string | null>(null);
  const [scheduleProposal, setScheduleProposal] = useState<ScheduleProposal | null>(null);
  const [undo, setUndo] = useState<{ before: Data; after: Data; label: string } | null>(null);
  const [colorEdit, setColorEdit] = useState<{ id: string; anchor: Anchor } | null>(null);
  const [selected, setSelected] = useState('');
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const pendingScroll = useRef<number | null>(null);
  function selectProject(id: string) {
    pendingScroll.current = window.scrollY;
    setSelected(id);
    setProjectPickerOpen(false);
  }
  useLayoutEffect(() => {
    if (pendingScroll.current !== null) {
      window.scrollTo(0, pendingScroll.current);
      pendingScroll.current = null;
    }
  }, [selected]);
  const [materialTab, setMaterialTab] = useState(0);
  const [view, setView] = useState<View>('overview');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [agendaEntry, setAgendaEntry] = useState<AgendaEntryRequest | null>(null);
  const [focusedRecord, setFocusedRecord] = useState<WorkRecord | null>(null);
  const recordDirty = useRef(false);
  const recordSource = useWorkRecords(
    isCloud &&
      ready &&
      ['overview', 'schedule', 'completed', 'records', 'reminders'].includes(view),
  );
  const [metricFilter, setMetricFilter] = useState('');
  const [projectStatusFilter, setProjectStatusFilter] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [purchaseFilter, setPurchaseFilter] = useState('全部');
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
  const baseCount = stats(data, now);
  const count = {
    ...baseCount,
    todos:
      baseCount.todos +
      recordSource.records.filter(
        (r) =>
          !r.deleted &&
          r.nodeDate &&
          r.nodeDate <= now &&
          !['已完成', '已取消'].includes(r.status) &&
          data.projects.some((project) => project.id === r.projectId && !isHistorical(project)),
      ).length,
  };
  const procurement = procurementView(data, p?.id, now);
  const agenda = categorizedAgenda(data, recordSource.records, p?.id, now);
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);
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
    setUndo({ before, after: stamped, label });
  }
  function changeTask(value: Task) {
    const plan = data.tasks.some((t) => t.id === value.id)
      ? proposeTaskChanges(data, [value])
      : proposeTaskChange(data, value);
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
  function save(kind: Edit['kind'], value: Entity, intent?: { colorChanged?: boolean }) {
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
          trades: exists ? d.trades : [...d.trades, ...newProjectTrades(d, v.id)],
        };
      }
      if (kind === 'trade' && !d.trades.some((t) => t.id === value.id)) {
        const g = value as Trade;
        const inserted = intent?.colorChanged
          ? g
          : {
              ...g,
              color: initialStageColor(d, g.name, g.color, g.projectId),
              defaultColor: defaultTradeColor(g.name) || g.defaultColor,
            };
        const next = insertTrade(d, inserted);
        const colored = intent?.colorChanged
          ? saveTradeColor(next, value.id, inserted.color)
          : next;
        return {
          ...colored,
          recentColors: [
            inserted.color,
            ...next.recentColors.filter((c) => c !== inserted.color),
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
      return kind === 'trade' && intent?.colorChanged
        ? saveTradeColor(next, value.id, (value as Trade).color)
        : next;
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
    const color = nextTradeColor(data, p.id, index);
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
      setAgendaEntry({ projectId: p.id, date, id: id() });
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
              : current.kind === 'purchase'
                ? '删除后不再提醒。云端保留操作历史，独立材料和库存流水不会删除。'
                : '此事项将从列表移除；原有审计及15天版本历史按原规则保留。不删除项目、采购或施工任务。',
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
    if (isCloud) {
      setRestoreError('云空间请从云端账号中预览导入，不使用本地覆盖恢复。');
      return;
    }
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
  const projectPurchases = procurement.all
    .filter(
      (x) =>
        x.projectId === p?.id &&
        (!onlyOpen || !purchaseComplete(x)) &&
        (purchaseFilter === '全部' ||
          (purchaseFilter === '已完成' ? purchaseComplete(x) : !purchaseComplete(x))) &&
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
        onDelete={() => deleteEntity({ kind: 'purchase', value: x })}
        canReopen={!isCloud || !!cloudUser?.owner}
        showProject={view === 'reminders' || view === 'purchases'}
        onStatus={(status) => save('purchase', { ...x, due: purchaseDue(x, data), status })}
      />
    );
  }
  function go(v: View, confirmed = false) {
    if (
      !confirmed &&
      !window.dispatchEvent(
        new CustomEvent('chunmo-before-navigation', {
          cancelable: true,
          detail: { resume: () => go(v, true) },
        }),
      )
    )
      return;
    setView(v);
    if (v === 'completed') {
      setArchived(true);
    } else if (v === 'overview') {
      setArchived(false);
    }
    setSearch('');
    setOnlyOpen(false);
    setMetricFilter('');
    setShowAllProjects(false);
    setProjectStatusFilter(false);
  }
  function agendaItem(item: AgendaEntry) {
    if (item.kind === 'legacy')
      return (
        <NoteCard
          key={'legacy:' + item.id}
          note={item.value}
          projectName={data.projects.find((project) => project.id === item.projectId)?.name}
          now={now}
          onEdit={() => noteEditor(item.value)}
          onToggle={() => save('note', { ...item.value, done: !item.done })}
          onPin={() => save('note', { ...item.value, pinned: !item.value.pinned })}
          onDelete={() => deleteEntity({ kind: 'note', value: item.value })}
        />
      );
    return (
      <AgendaItem
        key={item.kind + ':' + item.id}
        item={item}
        projectName={
          data.projects.find((project) => project.id === item.projectId)?.name || '历史项目'
        }
        busy={recordSource.busyIds.includes(item.id)}
        canToggle={
          item.status !== '已取消' &&
          !(item.kind === 'purchase' && item.done && isCloud && !cloudUser?.owner)
        }
        onOpen={() => {
          if (item.kind === 'purchase') {
            go('purchases');
            purchaseEditor(item.value);
          } else if (item.kind === 'record') {
            go('records');
            recordDirty.current = false;
            setFocusedRecord(item.value);
          }
        }}
        onToggle={() => {
          if (item.kind === 'purchase')
            save('purchase', {
              ...item.value,
              due: purchaseDue(item.value, data),
              status: item.done ? '待采购' : '已完成',
            });
          else if (item.kind === 'record') void recordSource.toggle(item.value);
        }}
      />
    );
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
          {recordSource.records
            .filter(
              (r) =>
                !r.deleted &&
                r.nodeDate &&
                r.nodeDate <= now &&
                !['已完成', '已取消'].includes(r.status) &&
                active.has(r.projectId),
            )
            .map((r) => (
              <button
                className="reminder-item"
                key={'record:' + r.id}
                onClick={() => {
                  go('records');
                  recordDirty.current = false;
                  setFocusedRecord(r);
                }}
              >
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {data.projects.find((project) => project.id === r.projectId)?.name} · 事项
                  </small>
                </span>
                <em>
                  {r.nodeDate} · {r.status}
                </em>
              </button>
            ))}
        </div>
      </div>
    );
  }
  return (
    <ThemedWorkspace
      projects={data.projects}
      scope={cloudUser?.workspaceId || 'local'}
      projectId={p?.id}
      className={`app-shell${view === 'overview' ? ' homepage' : ''}`}
      data-view={view}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go('overview');
          }}
        >
          {BRAND_LOGO_SRC && <img src={BRAND_LOGO_SRC} alt="春茉空间设计 Logo" />}
          <div>
            <strong className="brand-name">{BRAND_NAME}</strong>
            <span className="brand-slogan">{BRAND_SLOGAN}</span>
          </div>
        </a>
        <div className="sidebar-section">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav>
          <div className="workspace-nav-heading">
            <button className={view === 'overview' ? 'active' : ''} onClick={() => go('overview')}>
              <LayoutDashboard size={19} />
              <span>项目工作空间</span>
            </button>
            <button
              aria-label="展开或收起项目菜单"
              aria-expanded={navExpanded}
              aria-controls="workspace-subnav"
              onClick={toggleNavigation}
            >
              <ChevronDown size={16} />
            </button>
          </div>
          <div
            id="workspace-subnav"
            className={`workspace-subnav ${navExpanded ? 'expanded' : ''}`}
            inert={!navExpanded}
          >
            <div>
              {navigation
                .filter(([key]) => key !== 'overview' && key !== 'people' && key !== 'materials')
                .map(([key, label, icon]) => (
                  <button
                    key={key}
                    aria-label={label}
                    className={view === key ? 'active' : ''}
                    onClick={() => go(key)}
                  >
                    {icon}
                    <span>{label}</span>
                    {key === 'reminders' && count.overduePurchases + count.overdueTasks > 0 && (
                      <b>{count.overduePurchases + count.overdueTasks}</b>
                    )}
                  </button>
                ))}
            </div>
          </div>
          <button className={view === 'people' ? 'active' : ''} onClick={() => go('people')}>
            <Users size={19} />
            <span>人员管理</span>
          </button>
          <button className={view === 'materials' ? 'active' : ''} onClick={() => go('materials')}>
            <Package size={19} />
            <span>材料资产管理</span>
          </button>
        </nav>
        <section
          className={`sidebar-projects ${projectPickerOpen ? 'picker-open' : ''}`}
          aria-label="项目选择器"
        >
          <button
            className="mobile-project-toggle"
            aria-expanded={projectPickerOpen}
            onClick={() => setProjectPickerOpen(!projectPickerOpen)}
          >
            {p?.name || '选择项目'} <ChevronDown size={15} />
          </button>
          <div className="sidebar-project-list">
            <div className="sidebar-section">
              {archived ? '已完工项目' : '当前项目'} <span>{projects.length}</span>
            </div>
            <ProjectCards
              data={data}
              projects={projects}
              selected={p?.id ?? ''}
              onSelect={selectProject}
              onEdit={(project) => setEdit({ kind: 'project', value: project })}
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
            {!projects.length && <p className="muted">暂无项目</p>}
          </div>
        </section>
        <div className="sidebar-bottom">
          <button
            disabled={!ready}
            onClick={() =>
              setHistoryOpen({
                scope: view === 'people' ? GLOBAL_SCOPE : (p?.id ?? GLOBAL_SCOPE),
              })
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
            {isCloud ? '云端工作空间' : '本地工作空间'} <i />
          </p>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <CloudControl isCloud={isCloud} dirty={hasUnsavedChanges} />
          <button
            className="mobile-history"
            aria-label="版本历史 · 15天"
            title="版本历史 · 15天"
            disabled={!ready}
            onClick={() =>
              setHistoryOpen({
                scope: view === 'people' ? GLOBAL_SCOPE : (p?.id ?? GLOBAL_SCOPE),
              })
            }
          >
            <HistoryIcon size={17} />
          </button>
          <div className="mobile-brand">
            <strong className="brand-name">{BRAND_NAME}</strong>
          </div>
          <button
            className="icon-btn workspace-backup"
            aria-label="备份数据"
            title="备份数据"
            onClick={() => setBackup(true)}
            disabled={!ready}
          >
            <ArrowDownToLine size={17} />
          </button>
          <div
            className={`save-state compact-save ${status.includes('已保存') && !undo ? 'sr-only' : ''} ${status.includes('失败') ? 'red' : ''}`}
            role="status"
          >
            <span>{status}</span>
            {undo && (
              <button
                className="undo-quiet"
                title={undo.label}
                onClick={() => {
                  const reverted = mergeWorkspace(undo.after, undo.before, data);
                  if (reverted.conflicts.length) {
                    notify('该工序已有新的修改，未执行撤销。请核对当前日期后再调整。');
                    return;
                  }
                  update(() => parseBackup(reverted.data));
                  setUndo(null);
                }}
              >
                撤销
              </button>
            )}
          </div>
          <CollaborationBar user={cloudUser} isCloud={isCloud} />
        </header>
        <main className="workspace-content">
          {draftRecoveryNotice && (
            <div className="error-banner" role="status">
              <span>{draftRecoveryNotice}</span>
              <button
                onClick={() =>
                  void draftRecoveryPackage()
                    .then((value) =>
                      downloadBlob(
                        new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
                        '春茉-旧草稿恢复包.json',
                      ),
                    )
                    .catch((e) => notify(String(e)))
                }
              >
                下载旧草稿恢复包
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={18} />
              <span>{error}</span>
              {ready ? (
                <>
                  <button onClick={() => void retry()}>重试保存</button>
                  {isCloud && (
                    <button onClick={() => void reloadCloud().catch((e) => notify(String(e)))}>
                      重新读取云端
                    </button>
                  )}
                  <button onClick={() => backupJSON(data)}>紧急备份</button>
                </>
              ) : (
                <button onClick={() => window.location.reload()}>重新读取</button>
              )}
            </div>
          )}
          <div
            className={`page-heading workbench-page-heading ${view === 'records' ? 'board-page-heading' : ''}`}
          >
            <div>
              <div className="eyebrow">RENOVATION WORKSPACE</div>
              <h1>
                {view === 'records'
                  ? '事项管理'
                  : view === 'overview'
                    ? '项目工作空间'
                    : view === 'schedule'
                      ? '施工计划'
                      : view === 'purchases'
                        ? '材料采购管理'
                        : view === 'completed'
                          ? '已完工项目'
                          : view === 'materials'
                            ? '材料资产管理'
                            : view === 'people'
                              ? '人员管理'
                              : '项目提醒中心'}
              </h1>
              <p>
                {view === 'records'
                  ? '围绕项目，记录节点、现场进展与每一次跟进。'
                  : view === 'overview'
                    ? '工期有序，细节有据。从设计到落地，悉心照料每一个家。'
                    : view === 'schedule'
                      ? '以清晰的时间线，串联每一道施工工序。'
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
          <div
            className="stats-grid ui-module-group"
            hidden={view === 'people' || view === 'materials' || view === 'records'}
          >
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
          ) : view === 'records' ? (
            <>
              <DeferredPanel>
                <RecordBoard projects={data.projects} isCloud={isCloud} source={recordSource} />
              </DeferredPanel>
            </>
          ) : view === 'reminders' ? (
            <>
              {reminderItems()}
              {isCloud && (
                <DeferredPanel>
                  <MaterialAlertSummary
                    onOpen={() => {
                      setMaterialTab(5);
                      go('materials');
                    }}
                  />
                </DeferredPanel>
              )}
            </>
          ) : view === 'materials' ? (
            <DeferredPanel key="materials">
              <MaterialsPanel data={data} isCloud={isCloud} initialTab={materialTab} />
            </DeferredPanel>
          ) : view === 'people' ? (
            <DeferredPanel key="people">
              <PeoplePanel isCloud={isCloud} data={data} onChange={(fn) => mutate(fn)} />
            </DeferredPanel>
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
                {p ? (
                  <ProjectContext project={p} />
                ) : (
                  <strong className="current-project-name">暂无项目</strong>
                )}
                <div className="toolbar">
                  {p && (
                    <>
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
                  {recordSource.error && (
                    <div className="error-banner" role="alert">
                      <span>事项读取或保存失败：{recordSource.error}</span>
                      <button onClick={() => void recordSource.load()}>重新读取事项</button>
                    </div>
                  )}
                  {(view === 'overview' || view === 'schedule' || view === 'completed') && (
                    <div
                      className="workspace-brief agenda-brief ui-module-group"
                      aria-label="当前工地事项安排"
                    >
                      <BriefPanel
                        key={'today' + p.id}
                        title="今日事项"
                        testId="today-panel"
                        id="project-today"
                        className="today-panel"
                        emptyText={
                          recordSource.loading
                            ? '正在读取事项…'
                            : recordSource.error
                              ? '事项读取失败，请重试'
                              : '今日暂无待办事项'
                        }
                        date={agenda.date}
                        items={agenda.today.map(agendaItem)}
                        actions={
                          <>
                            <button className="text-btn" onClick={() => noteEditor()}>
                              <Plus size={14} />
                              添加今日事项
                            </button>
                            <button className="text-btn" onClick={() => go('records')}>
                              全部事项
                              <ArrowRight size={14} />
                            </button>
                          </>
                        }
                      />
                      <BriefPanel
                        key={'tomorrow' + p.id}
                        title="明日提醒"
                        testId="tomorrow-panel"
                        id="project-tomorrow"
                        className="tomorrow-panel"
                        emptyText={
                          recordSource.loading
                            ? '正在读取事项…'
                            : recordSource.error
                              ? '事项读取失败，请重试'
                              : '明日暂无安排'
                        }
                        date={agenda.tomorrowDate}
                        items={agenda.tomorrow.map(agendaItem)}
                        actions={
                          <button
                            className="text-btn"
                            onClick={() => noteEditor(undefined, agenda.tomorrowDate)}
                          >
                            <Plus size={14} />
                            添加明日事项
                          </button>
                        }
                      />
                    </div>
                  )}
                  {(view === 'overview' || view === 'schedule' || view === 'completed') && (
                    <p className="schedule-forecast" role="status">
                      {scheduleForecast(data, p).label} · 工期按自然日计算
                    </p>
                  )}
                  <ConflictPanel data={data} projectId={p.id} />
                  {(view === 'overview' || view === 'schedule' || view === 'completed') && (
                    <Gantt
                      data={data}
                      project={p}
                      onTask={taskEditor}
                      onDeleteTask={(t) => deleteEntity({ kind: 'task', value: t })}
                      onQuickCreate={(g, date) => {
                        try {
                          changeTask({
                            id: id(),
                            projectId: p.id,
                            tradeId: g.id,
                            name: g.name,
                            start: date,
                            end: date,
                            owner: '',
                            status: '未开始',
                            notes: '',
                            staffIds: g.staffIds,
                          });
                        } catch (e) {
                          notify(`无法创建施工任务：${e instanceof Error ? e.message : String(e)}`);
                        }
                      }}
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
                          const plan = proposeTaskChanges(data, t);
                          if (plan.affected.length) setScheduleProposal(plan);
                          else commitSchedule(plan.current, plan.base, '工期已保存，可撤销。');
                        } catch (e) {
                          notify(`工期调整失败：${e instanceof Error ? e.message : String(e)}`);
                        }
                      }}
                    />
                  )}
                  {view === 'purchases' && (
                    <section className="records-section">
                      <div className="purchase-toolbar" role="toolbar" aria-label="采购清单工具栏">
                        <h2>
                          采购清单 <span className="count">{projectPurchases.length} 条记录</span>
                        </h2>
                        <div className="search-field">
                          <Search size={16} />
                          <input
                            placeholder="搜索材料、规格或负责人…"
                            aria-label="搜索采购记录"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                          />
                        </div>
                        <label className="purchase-filter">
                          <span className="sr-only">采购状态</span>
                          <select
                            aria-label="采购记录筛选"
                            value={purchaseFilter}
                            onChange={(e) => {
                              setPurchaseFilter(e.target.value);
                              setOnlyOpen(false);
                            }}
                          >
                            <option>全部</option>
                            <option>待采购</option>
                            <option>已完成</option>
                          </select>
                        </label>
                        <button
                          className="purchase-open-toggle"
                          aria-pressed={onlyOpen}
                          onClick={() => setOnlyOpen((v) => !v)}
                        >
                          <Check size={14} aria-hidden="true" />
                          只看未完成
                        </button>
                        <button className="primary purchase-add" onClick={() => purchaseEditor()}>
                          <Plus size={15} />
                          新增采购
                        </button>
                      </div>
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
      {saveConflict && (
        <WorkspaceSaveConflict
          key={saveConflict.current.revision}
          conflict={saveConflict}
          onResolve={resolveSaveConflict}
          onClose={dismissSaveConflict}
        />
      )}
      {agendaEntry && (
        <DeferredPanel>
          <AgendaEntryDialog
            key={agendaEntry.id}
            request={agendaEntry}
            data={data}
            isCloud={isCloud}
            onClose={() => setAgendaEntry(null)}
            onPurchase={(kind, value) => {
              save(kind, value);
              setAgendaEntry(null);
              go('purchases');
            }}
            onRecord={(record) => {
              recordSource.accept(record);
              setAgendaEntry(null);
              go('records');
            }}
          />
        </DeferredPanel>
      )}
      {focusedRecord && (
        <DeferredPanel>
          <RecordDrawer
            key={focusedRecord.id}
            record={focusedRecord}
            initialProject={focusedRecord.projectId}
            projects={data.projects}
            latest={recordSource.records.find((r) => r.id === focusedRecord.id)}
            onDirty={(v) => {
              recordDirty.current = v;
            }}
            onSaved={(record) => {
              recordSource.accept(record);
              setFocusedRecord(null);
            }}
            onClose={() => {
              if (!recordDirty.current) setFocusedRecord(null);
              else
                setConfirmation({
                  title: '放弃未保存的事项修改？',
                  message: '已保存记录和历史不受影响。',
                  run: () => {
                    setFocusedRecord(null);
                    setConfirmation(null);
                  },
                });
            }}
          />
        </DeferredPanel>
      )}
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
              },
            });
          }}
          data={data}
          onDeadlineChange={
            !isCloud || cloudUser?.owner ? (p) => setDeadlineChange(p.id) : undefined
          }
          onClose={() => setEdit(null)}
          onSave={save}
          onDelete={
            isExisting && (!isCloud || !!cloudUser?.owner || edit.kind !== 'project')
              ? () => deleteEntity()
              : undefined
          }
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
          canRestore={status === '已保存' && (!isCloud || !!cloudUser?.owner)}
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
                {isCloud
                  ? '业务数据保存在当前云工作空间的服务端数据库。本地IndexedDB未上传或清除；云端导入请通过云端账号的预览确认流程。'
                  : '数据保存在当前浏览器的 IndexedDB 中。清除网站数据、切换浏览器或设备会导致无法访问这些记录。请将 JSON 备份妥善保存。'}
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
            {!isCloud && (
              <button className="backup-action" onClick={() => fileRef.current?.click()}>
                <Upload size={24} />
                <span>
                  <strong>从 JSON 备份恢复</strong>
                  <small>先校验文件，再确认替换所有本地数据</small>
                </span>
                <ArrowRight size={19} />
              </button>
            )}
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
          onChange={(color, final) =>
            save(
              'trade',
              { ...data.trades.find((g) => g.id === colorEdit.id)!, color },
              { colorChanged: final },
            )
          }
          onClose={() => setColorEdit(null)}
        />
      )}
      {scheduleProposal && (
        <ScheduleConfirm
          proposal={scheduleProposal}
          onCancel={() => {
            setScheduleProposal(null);
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
              shift
                ? scheduleProposal.advance
                  ? '后续工期已提前，可撤销。'
                  : '后续工期已顺延，可撤销。'
                : '已仅调整当前工序，可撤销。',
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
          cloud={isCloud}
          onConfirm={async (date, reason) => {
            if (isCloud) await changeDeadline(deadlineChange, date, reason);
            else mutate((d) => confirmPurchaseDeadline(d, deadlineChange, date, reason));
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
    </ThemedWorkspace>
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
  onDelete,
  now,
  projectName,
}: {
  projectName?: string;
  note: Note;
  onEdit: () => void;
  onToggle: () => void;
  onPin: () => void;
  onDelete?: () => void;
  now?: string;
}) {
  return (
    <article className={`note-card ${n.done ? 'done' : ''}`} data-note-id={n.id}>
      <button
        className={`todo-check ${n.done ? 'checked' : ''}`}
        aria-label={`${n.done ? '标记未完成' : '完成'}${n.title}`}
        onClick={onToggle}
      >
        {n.done && <Check size={13} />}
      </button>
      <button className="note-main" onClick={onEdit}>
        <span className="note-kind">
          {projectName && (
            <>
              <span className="agenda-category">事项</span> {projectName} ·{' '}
              {n.done ? '已完成' : '待执行'} ·{' '}
            </>
          )}
          {n.kind} {n.kind !== '项目备忘' && n.date && `· ${n.date}`}{' '}
          {n.kind !== '项目备忘' && noteDue(n) && !n.done && `· ${remainingTime(noteDue(n), now)}`}
        </span>
        <h3>{n.title}</h3>
        {n.content && <p>{n.content}</p>}
        {(n.owner || n.reminder) && (
          <small>
            {n.owner}
            {n.reminder && ` · 提醒 ${n.reminder}`}
          </small>
        )}
      </button>
      <button
        className={`pin-btn ${n.pinned ? 'pinned' : ''}`}
        aria-label={`${n.pinned ? '取消置顶' : '置顶'}${n.title}`}
        onClick={onPin}
      >
        <Pin size={15} />
      </button>
      {onDelete && (
        <button
          className="note-delete text-btn destructive"
          aria-label={`删除事项${n.title}`}
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </button>
      )}
    </article>
  );
}
