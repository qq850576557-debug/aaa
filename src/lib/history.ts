import { z } from 'zod';
import { emptyData, id, parseBackup, type Data } from './model';

export const RETENTION = 15 * 24 * 60 * 60 * 1000;
export const GLOBAL_SCOPE = '@global';
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_RECORDS = 10000;
export type ProjectSnapshot = Pick<Data, 'projects' | 'trades' | 'tasks' | 'notes' | 'purchases'>;
export type GlobalSnapshot = Pick<
  Data,
  'people' | 'nameHistory' | 'recentColors' | 'dictionaries'
> & {
  projectOrder: string[];
};
export type Snapshot =
  { kind: 'project'; data: ProjectSnapshot } | { kind: 'global'; data: GlobalSnapshot };
export type Change = { module: string; label: string; before: string; after: string };
export type Revision = {
  id: string;
  scope: string;
  name: string;
  at: string;
  action: '新增' | '修改' | '删除' | '恢复';
  source?: string;
  actor: string;
  actorId?: string;
  changes: Change[];
  before: string;
  after: string;
};
export type History = { version: 1; records: Revision[]; snapshots: Record<string, Snapshot> };
export const emptyHistory = (): History => ({ version: 1, records: [], snapshots: {} });
// Stable property ordering makes comparisons independent of JSON key ordering.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
export function snapshot(data: Data, scope: string): Snapshot {
  if (scope === GLOBAL_SCOPE)
    return {
      kind: 'global',
      data: {
        ...(data.people ? { people: data.people } : {}),
        ...(data.dictionaries ? { dictionaries: data.dictionaries } : {}),
        ...(data.nameHistory ? { nameHistory: data.nameHistory } : {}),
        recentColors: data.recentColors,
        projectOrder: data.projects.map((p) => p.id),
      },
    };
  return {
    kind: 'project',
    data: {
      projects: data.projects.filter((p) => p.id === scope),
      trades: data.trades.filter((p) => p.projectId === scope),
      tasks: data.tasks.filter((p) => p.projectId === scope),
      notes: data.notes.filter((p) => p.projectId === scope),
      purchases: data.purchases.filter((p) => p.projectId === scope),
    },
  };
}
function business(s: Snapshot) {
  return s.kind === 'global'
    ? s
    : { ...s, data: { ...s.data, projects: s.data.projects.map(({ updatedAt: _, ...p }) => p) } };
}
export function changed(a: Snapshot, b: Snapshot) {
  return canonical(business(a)) !== canonical(business(b));
}
const fields: Record<string, string> = {
  name: '名称',
  title: '标题',
  address: '地址',
  owner: '负责人/业主',
  manager: '项目经理',
  status: '状态',
  start: '开始日期',
  end: '结束日期',
  actualStart: '实际开工',
  actualEnd: '实际完工',
  notes: '备注',
  content: '内容',
  archived: '完工存放',
  color: '颜色',
  defaultColor: '默认颜色',
  order: '工种顺序',
  tradeId: '所属工种',
  date: '事项日期',
  reminder: '旧提醒日期',
  done: '完成状态',
  pinned: '置顶',
  taskId: '关联任务',
  dependsOn: '前序关系',
  groupId: '多段关联',
  personnel: '原有人员登记',
  staffIds: '人员关联',
  categoryId: '人员类别',
  tradeIds: '人员工种',
  usage: '工种用途',
  label: '选项名称',
  kind: '类型',
  due: '采购截止日期',
  originalDue: '原始采购期限',
  approvedDue: '确认期限',
  deadlineHistory: '期限确认记录',
  leadDays: '原提前量',
  deadlineMode: '日期计算方式',
  quantity: '数量',
  specification: '规格',
  role: '人员类别',
  trade: '所属工种',
  active: '启用状态',
  deleted: '删除标记',
};
const printable = (v: unknown) =>
  v === undefined ? '未设置' : typeof v === 'string' ? v : JSON.stringify(v);
export function differences(a: Snapshot, b: Snapshot): Change[] {
  const result: Change[] = [];
  if (a.kind === 'global' && b.kind === 'global') {
    for (const key of [
      'people',
      'dictionaries',
      'nameHistory',
      'recentColors',
      'projectOrder',
    ] as const)
      if (canonical(a.data[key]) !== canonical(b.data[key])) {
        if (key === 'people' || key === 'dictionaries')
          compareRows(
            a.data[key] ?? [],
            b.data[key] ?? [],
            key === 'people' ? '人员档案' : '人员字典',
            result,
          );
        else
          result.push({
            module: '工作空间',
            label: {
              nameHistory: '历史姓名候选',
              recentColors: '最近颜色',
              projectOrder: '项目顺序',
            }[key],
            before: printable(a.data[key]),
            after: printable(b.data[key]),
          });
      }
    const beforeIds = (a.data.people ?? []).map((p) => p.id),
      afterIds = (b.data.people ?? []).map((p) => p.id);
    const commonBefore = beforeIds.filter((key) => afterIds.includes(key)),
      commonAfter = afterIds.filter((key) => beforeIds.includes(key));
    if (canonical(commonBefore) !== canonical(commonAfter))
      result.push({
        module: '人员档案',
        label: '人员显示顺序',
        before: printable(commonBefore),
        after: printable(commonAfter),
      });
  } else if (a.kind === 'project' && b.kind === 'project') {
    for (const [key, module] of [
      ['projects', '项目资料'],
      ['trades', '施工工种'],
      ['tasks', '施工计划'],
      ['notes', '事项与备忘'],
      ['purchases', '采购管理'],
    ] as const)
      compareRows(a.data[key], b.data[key], module, result);
  }
  return result;
}
function compareRows(
  before: { id: string }[],
  after: { id: string }[],
  module: string,
  out: Change[],
) {
  const a = new Map(before.map((x) => [x.id, x])),
    b = new Map(after.map((x) => [x.id, x]));
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const old = a.get(key) as Record<string, unknown> | undefined,
      next = b.get(key) as Record<string, unknown> | undefined;
    const name = String(
      next?.name ?? next?.title ?? next?.label ?? old?.name ?? old?.title ?? old?.label ?? key,
    );
    if (!old || !next)
      out.push({
        module,
        label: `${!old ? '新增' : '删除'}「${name}」`,
        before: old ? printable(old) : '不存在',
        after: next ? printable(next) : '不存在',
      });
    else
      for (const f of new Set([...Object.keys(old), ...Object.keys(next)]))
        if (
          !['id', 'projectId', 'updatedAt'].includes(f) &&
          canonical(old[f]) !== canonical(next[f])
        )
          out.push({
            module,
            label: `${name} · ${fields[f] ?? f}`,
            before: printable(old[f]),
            after: printable(next[f]),
          });
  }
}
const changeSchema = z
  .object({ module: z.string(), label: z.string(), before: z.string(), after: z.string() })
  .strict();
const recordSchema = z
  .object({
    id: z.string().min(1),
    scope: z.string().min(1),
    name: z.string(),
    at: z.string().datetime(),
    action: z.enum(['新增', '修改', '删除', '恢复']),
    source: z.string().optional(),
    actor: z.string().trim().min(1).max(100),
    actorId: z.string().min(1).max(100).optional(),
    changes: z.array(changeSchema),
    before: z.string(),
    after: z.string(),
  })
  .strict();
export function validateHistory(raw: unknown): History {
  const shape = z
    .object({
      version: z.literal(1),
      records: z.array(recordSchema).max(MAX_RECORDS),
      snapshots: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(raw);
  const snapshots: Record<string, Snapshot> = Object.create(null);
  for (const [key, value] of Object.entries(shape.snapshots)) {
    const s = z
      .object({ kind: z.enum(['project', 'global']), data: z.unknown() })
      .strict()
      .parse(value);
    if (s.kind === 'project') {
      const d = parseBackup({
        ...emptyData(),
        ...z
          .object({
            projects: z.array(z.unknown()).max(1),
            trades: z.array(z.unknown()),
            tasks: z.array(z.unknown()),
            notes: z.array(z.unknown()),
            purchases: z.array(z.unknown()),
          })
          .strict()
          .parse(s.data),
        // Project snapshots reference the shared registry; validate those IDs during actual restore.
        people: personStubs(s.data),
      });
      snapshots[key] = {
        kind: 'project',
        data: {
          projects: d.projects,
          trades: d.trades,
          tasks: d.tasks,
          notes: d.notes,
          purchases: d.purchases,
        },
      };
    } else {
      const g = z
        .object({
          people: z.array(z.unknown()).optional(),
          dictionaries: z.array(z.unknown()).optional(),
          nameHistory: z.array(z.string()).optional(),
          recentColors: z.array(z.string()),
          projectOrder: z.array(z.string()).max(500),
        })
        .strict()
        .parse(s.data);
      const d = parseBackup({
        ...emptyData(),
        ...(g.people ? { people: g.people } : {}),
        ...(g.dictionaries ? { dictionaries: g.dictionaries } : {}),
        ...(g.nameHistory ? { nameHistory: g.nameHistory } : {}),
        recentColors: g.recentColors,
      });
      if (new Set(g.projectOrder).size !== g.projectOrder.length) throw Error('历史项目顺序重复');
      snapshots[key] = {
        kind: 'global',
        data: {
          ...(d.people ? { people: d.people } : {}),
          ...(d.dictionaries ? { dictionaries: d.dictionaries } : {}),
          ...(d.nameHistory ? { nameHistory: d.nameHistory } : {}),
          recentColors: d.recentColors,
          projectOrder: g.projectOrder,
        },
      };
    }
  }
  if (new Set(shape.records.map((r) => r.id)).size !== shape.records.length)
    throw Error('历史版本 ID 重复');
  for (const r of shape.records)
    for (const key of [r.before, r.after]) {
      const s = snapshots[key];
      if (
        !Object.hasOwn(snapshots, key) ||
        !s ||
        (r.scope === GLOBAL_SCOPE) !== (s.kind === 'global') ||
        (s.kind === 'project' && s.data.projects.some((p) => p.id !== r.scope))
      )
        throw Error('历史快照缺失或所属项目不符');
    }
  const result = { version: 1 as const, records: shape.records, snapshots };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES)
    throw Error('历史版本超过 128 MiB，请备份后处理；未清理有效版本');
  return result;
}
function personStubs(raw: unknown) {
  const d = raw as ProjectSnapshot;
  return [
    ...new Set([...d.projects, ...d.trades, ...d.tasks].flatMap((x) => x.staffIds ?? [])),
  ].map((id) => ({
    id,
    name: '历史关联校验',
    role: '施工人员',
    trade: '',
    notes: '',
    active: false,
  }));
}
export function retainHistory(history: History, now = Date.now()): History {
  const records = history.records.filter(
    (r) => Date.parse(r.at) >= now - RETENTION && Date.parse(r.at) <= now,
  );
  const used = new Set(records.flatMap((r) => [r.before, r.after]));
  return {
    version: 1,
    records,
    snapshots: Object.fromEntries(
      Object.entries(history.snapshots).filter(([key]) => used.has(key)),
    ),
  };
}
export function changeAction(changes: Change[]): Revision['action'] {
  if (
    changes.some((c) => c.label.startsWith('删除「')) ||
    changes.some((c) => c.label.endsWith('删除标记') && c.after === 'true')
  )
    return '删除';
  if (changes.length && changes.every((c) => c.label.startsWith('新增「'))) return '新增';
  return '修改';
}
export function recordChanges(
  previous: Data,
  input: Data,
  history: History,
  now = Date.now(),
  restore?: { scope: string; source: string },
): { data: Data; history: History } {
  const data = structuredClone(parseBackup(input));
  const h = retainHistory(history, now);
  const cache = new Map(Object.entries(h.snapshots).map(([key, s]) => [canonical(s), key]));
  const put = (s: Snapshot) => {
    const text = canonical(s);
    let key = cache.get(text);
    if (!key) {
      key = id();
      h.snapshots[key] = structuredClone(s);
      cache.set(text, key);
    }
    return key;
  };
  const scopes = new Set([
    ...previous.projects.map((p) => p.id),
    ...data.projects.map((p) => p.id),
    GLOBAL_SCOPE,
  ]);
  for (const scope of scopes) {
    const before = snapshot(previous, scope),
      candidate = snapshot(data, scope);
    const modified = changed(before, candidate);
    if (!modified && scope !== restore?.scope) {
      const prior = previous.projects.find((p) => p.id === scope),
        p = data.projects.find((p) => p.id === scope);
      if (prior && p) p.updatedAt = prior.updatedAt;
      continue;
    }
    const p = data.projects.find((p) => p.id === scope),
      old = previous.projects.find((p) => p.id === scope);
    if (p) p.updatedAt = new Date(now).toISOString();
    const after = snapshot(data, scope),
      changes = differences(before, after);
    h.records.push({
      id: id(),
      scope,
      name: p?.name ?? old?.name ?? '全局人员与工作空间',
      at: new Date(now).toISOString(),
      action:
        scope === restore?.scope || restore?.scope === '*'
          ? '恢复'
          : !old && scope !== GLOBAL_SCOPE
            ? '新增'
            : !p && scope !== GLOBAL_SCOPE
              ? '删除'
              : changeAction(changes),
      actor: '本地操作记录',
      changes,
      before: put(before),
      after: put(after),
      ...(scope === restore?.scope || restore?.scope === '*' ? { source: restore!.source } : {}),
    });
  }
  if (h.records.length > MAX_RECORDS)
    throw Error('15天有效历史超过10000条，请先备份；本次修改未写入，未丢弃有效版本');
  return { data: parseBackup(data), history: validateHistory(h) };
}
export function restoreBefore(
  data: Data,
  history: History,
  revisionId: string,
  now = Date.now(),
): Data {
  const h = validateHistory(history),
    record = h.records.find((r) => r.id === revisionId);
  if (!record || Date.parse(record.at) < now - RETENTION || Date.parse(record.at) > now)
    throw Error('此历史已超出15天或不存在，不能恢复');
  const s = h.snapshots[record.before];
  let next: Data;
  if (s.kind === 'project') {
    const scoped = s.data;
    const scope = record.scope;
    const place = data.projects.findIndex((p) => p.id === scope);
    const projects = data.projects.filter((p) => p.id !== scope);
    if (scoped.projects[0])
      projects.splice(place < 0 ? projects.length : place, 0, scoped.projects[0]);
    next = {
      ...data,
      projects,
      trades: [...data.trades.filter((x) => x.projectId !== scope), ...scoped.trades],
      tasks: [...data.tasks.filter((x) => x.projectId !== scope), ...scoped.tasks],
      notes: [...data.notes.filter((x) => x.projectId !== scope), ...scoped.notes],
      purchases: [...data.purchases.filter((x) => x.projectId !== scope), ...scoped.purchases],
    };
  } else {
    const g = s.data,
      order = new Map(g.projectOrder.map((id, i) => [id, i]));
    next = {
      ...data,
      people: g.people,
      dictionaries: g.dictionaries,
      nameHistory: g.nameHistory,
      recentColors: g.recentColors,
      projects: [...data.projects].sort(
        (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
      ),
    };
  }
  return parseBackup(next);
}

export function workspaceContent(data: Data) {
  return canonical({ ...data, projects: data.projects.map(({ updatedAt: _, ...p }) => p) });
}

export function mergeHistory(current: History, incoming: History, now = Date.now()): History {
  const a = retainHistory(validateHistory(current), now),
    b = retainHistory(validateHistory(incoming), now);
  const snapshots: Record<string, Snapshot> = Object.assign(Object.create(null), a.snapshots);
  for (const [id, value] of Object.entries(b.snapshots)) {
    if (snapshots[id] && canonical(snapshots[id]) !== canonical(value))
      throw Error('备份历史快照 ID 冲突，未覆盖现有版本');
    snapshots[id] = value;
  }
  const records = new Map(a.records.map((r) => [r.id, r]));
  for (const record of b.records) {
    if (records.has(record.id) && canonical(records.get(record.id)) !== canonical(record))
      throw Error('备份历史记录 ID 冲突，未覆盖现有版本');
    records.set(record.id, record);
  }
  return validateHistory({
    version: 1,
    records: [...records.values()].sort((a, b) => a.at.localeCompare(b.at)),
    snapshots,
  });
}
export function parseArchive(raw: unknown): { data: Data; history?: History } {
  if (raw && typeof raw === 'object' && 'format' in raw) {
    const archive = z
      .object({
        format: z.literal('chunmo-history-backup'),
        version: z.literal(1),
        data: z.unknown(),
        history: z.unknown(),
      })
      .strict()
      .parse(raw);
    return {
      data: parseBackup(archive.data),
      history: retainHistory(validateHistory(archive.history)),
    };
  }
  return { data: parseBackup(raw) };
}
