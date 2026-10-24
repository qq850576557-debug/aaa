import { z } from 'zod';
import { addDays, differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';

export const today = () => format(new Date(), 'yyyy-MM-dd');
export const dateOK = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  isValid(parseISO(s)) &&
  format(parseISO(s), 'yyyy-MM-dd') === s &&
  s >= '1900-01-01' &&
  s <= '2200-12-31';
export const plus = (s: string, n: number) => format(addDays(parseISO(s), n), 'yyyy-MM-dd');
export const distance = (a: string, b: string) =>
  differenceInCalendarDays(parseISO(b), parseISO(a));
export const duration = (a: string, b: string) => distance(a, b) + 1;
export const days = (a: string, b: string) =>
  Array.from({ length: Math.max(0, duration(a, b)) }, (_, i) => plus(a, i));
export const shortDate = (s: string) => s.slice(5).replace('-', '.');
export const weekday = (s: string) => '日一二三四五六'[parseISO(s).getDay()];
export const id = () => crypto.randomUUID();
const text = z.string().max(4000);
const name = z.string().trim().min(1, '请输入名称').max(100);
const date = z.string().refine(dateOK, '日期无效（支持 1900—2200 年）');
const optionalDate = z.union([date, z.literal('')]);
const uid = z.string().min(1).max(100);
export const personnelSchema = z
  .object({
    worker: z.string().trim().max(4000),
    manager: z.string().trim().max(4000),
    designer: z.string().trim().max(4000),
  })
  .strict();
export type Personnel = z.infer<typeof personnelSchema>;
export const projectSchema = z
  .object({
    id: uid,
    name,
    address: text,
    owner: text,
    manager: text,
    status: z.enum(['施工中', '筹备中', '进行中', '已完工', '暂停']),
    start: date,
    end: date,
    actualStart: optionalDate,
    actualEnd: optionalDate,
    notes: text,
    archived: z.boolean(),
    personnel: personnelSchema.optional(),
    staffIds: z.array(uid).max(100).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((p) => p.end >= p.start, { message: '完工日期不能早于开工日期', path: ['end'] })
  .refine((p) => !p.actualEnd || (!!p.actualStart && p.actualEnd >= p.actualStart), {
    message: '实际完工日期需晚于实际开工日期',
    path: ['actualEnd'],
  })
  .refine((p) => duration(p.start, p.end) <= 1096, {
    message: '单项目计划跨度最多 3 年',
    path: ['end'],
  });
export const tradeSchema = z
  .object({
    id: uid,
    projectId: uid,
    name,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    defaultColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    order: z.number().int().nonnegative(),
    personnel: personnelSchema.optional(),
    staffIds: z.array(uid).max(100).optional(),
  })
  .strict();
export const taskSchema = z
  .object({
    id: uid,
    projectId: uid,
    tradeId: uid,
    name,
    start: date,
    end: date,
    owner: text,
    status: z.enum(['未开始', '进行中', '已完成', '已延期']),
    notes: text,
    groupId: uid.optional(),
    personnel: personnelSchema.optional(),
    dependsOn: z.array(uid).max(100).optional(),
    staffIds: z.array(uid).max(100).optional(),
  })
  .strict()
  .refine((t) => t.end >= t.start, { message: '结束日期不能早于开始日期', path: ['end'] })
  .refine((t) => duration(t.start, t.end) <= 1096, { message: '任务跨度最多 3 年', path: ['end'] });
export const noteSchema = z
  .object({
    id: uid,
    projectId: uid,
    title: name,
    kind: z.enum([
      '施工安排',
      '材料采购',
      '业主确认',
      '现场复核',
      '到货验收',
      '其他事项',
      '项目备忘',
    ]),
    date: optionalDate,
    reminder: optionalDate,
    owner: text,
    content: text,
    done: z.boolean(),
    pinned: z.boolean(),
    taskId: uid.optional(),
  })
  .strict()
  .refine((n) => n.kind === '项目备忘' || !!n.date, {
    message: '每日事项需要指定日期',
    path: ['date'],
  });
export const purchaseSchema = z
  .object({
    id: uid,
    projectId: uid,
    name,
    taskId: z.string().max(100),
    due: date,
    leadDays: z.number().int().min(0).max(365),
    quantity: z.string().max(100).optional(),
    specification: text.optional(),
    status: z.enum(['待采购', '已下单', '已到货', '已完成']),
    originalDue: date.optional(),
    deadlineMode: z.enum(['fixed', 'linked']).optional(),
    approvedDue: date.optional(),
    deadlineHistory: z
      .array(
        z
          .object({
            from: date,
            to: date,
            at: z.string().datetime(),
            reason: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
    owner: text,
    notes: text,
  })
  .strict();
export const dictionarySchema = z
  .object({
    id: uid,
    kind: z.enum(['category', 'trade']),
    label: name,
    active: z.boolean(),
    deleted: z.boolean().optional(),
    order: z.number().int().nonnegative(),
  })
  .strict();
export type DictionaryItem = z.infer<typeof dictionarySchema>;
export const personSchema = z
  .object({
    id: uid,
    name,
    role: z.enum(['施工人员', '项目经理', '设计人员', '监理']),
    trade: z.string().max(100),
    categoryId: uid.optional(),
    tradeIds: z.array(uid).max(100).optional(),
    notes: text,
    active: z.boolean(),
    deleted: z.boolean().optional(),
  })
  .strict();
export type Person = z.infer<typeof personSchema>;
export const dataSchema = z
  .object({
    version: z.literal(1),
    people: z.array(personSchema).max(2000).optional(),
    dictionaries: z.array(dictionarySchema).max(2000).optional(),
    nameHistory: z.array(z.string().trim().min(1).max(100)).max(2000).optional(),
    projects: z.array(projectSchema).max(500),
    trades: z.array(tradeSchema).max(5000),
    tasks: z.array(taskSchema).max(20000),
    notes: z.array(noteSchema).max(20000),
    purchases: z.array(purchaseSchema).max(20000),
    recentColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(12),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const list of [d.projects, d.trades, d.tasks, d.notes, d.purchases, d.people ?? []]) {
      if (new Set(list.map((x) => x.id)).size !== list.length)
        ctx.addIssue({ code: 'custom', message: '备份中存在重复 ID' });
    }
    const dictionaries = d.dictionaries ?? [];
    if (new Set(dictionaries.map((x) => x.id)).size !== dictionaries.length)
      ctx.addIssue({ code: 'custom', message: '字典ID重复' });
    for (const person of d.people ?? []) {
      if (
        person.categoryId &&
        !dictionaries.some((x) => x.id === person.categoryId && x.kind === 'category')
      )
        ctx.addIssue({ code: 'custom', message: '人员类别引用无效，请先恢复字典' });
      if (
        person.tradeIds?.some(
          (id) => !dictionaries.some((x) => x.id === id && x.kind === 'trade'),
        ) ||
        new Set(person.tradeIds).size !== (person.tradeIds?.length ?? 0)
      )
        ctx.addIssue({ code: 'custom', message: '人员工种引用无效或重复，请先恢复字典' });
    }
    const people = new Set((d.people ?? []).map((p) => p.id));
    for (const item of [...d.projects, ...d.trades, ...d.tasks])
      if (
        item.staffIds?.some((id) => !people.has(id)) ||
        new Set(item.staffIds).size !== (item.staffIds?.length ?? 0)
      )
        ctx.addIssue({ code: 'custom', message: '人员关联无效或重复，请先恢复对应人员档案' });
    for (const p of d.projects) {
      const [a, b] = projectRange(d, p);
      if (duration(a, b) > 1096)
        ctx.addIssue({ code: 'custom', message: '项目与任务的合并日期跨度不能超过 3 年' });
    }
    const projects = new Set(d.projects.map((p) => p.id));
    for (const x of [...d.trades, ...d.tasks, ...d.notes, ...d.purchases])
      if (!projects.has(x.projectId))
        ctx.addIssue({ code: 'custom', message: '存在无所属项目的记录' });
    for (const t of d.tasks)
      if (!d.trades.some((g) => g.id === t.tradeId && g.projectId === t.projectId))
        ctx.addIssue({ code: 'custom', message: '任务的工种关联无效' });
    for (const n of d.notes)
      if (n.taskId && !d.tasks.some((t) => t.id === n.taskId && t.projectId === n.projectId))
        ctx.addIssue({ code: 'custom', message: '事项的任务关联无效' });
    for (const p of d.purchases) {
      const history = p.deadlineHistory ?? [];
      if (
        p.approvedDue &&
        (!p.originalDue || !history.length || history.at(-1)?.to !== p.approvedDue)
      )
        ctx.addIssue({ code: 'custom', message: '采购期限变更缺少完整确认记录' });
      if (
        history.length &&
        (!p.originalDue ||
          !p.approvedDue ||
          history[0].from !== p.originalDue ||
          history.some((h, i) => i > 0 && h.from !== history[i - 1].to))
      )
        ctx.addIssue({ code: 'custom', message: '采购原始期限与变更记录不一致' });
      if (p.deadlineMode === 'fixed' && p.originalDue && p.due > (p.approvedDue ?? p.originalDue))
        ctx.addIssue({ code: 'custom', message: '采购日期超过原定或已确认期限' });
    }
    const byId = new Map(d.tasks.map((t) => [t.id, t]));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    function visit(t: z.infer<typeof taskSchema>) {
      if (visiting.has(t.id)) {
        ctx.addIssue({ code: 'custom', message: '前序任务存在循环依赖' });
        return;
      }
      if (visited.has(t.id)) return;
      visiting.add(t.id);
      for (const dep of t.dependsOn ?? []) {
        const parent = byId.get(dep);
        if (!parent || parent.projectId !== t.projectId)
          ctx.addIssue({ code: 'custom', message: '前序任务关联无效' });
        else visit(parent);
      }
      visiting.delete(t.id);
      visited.add(t.id);
    }
    d.tasks.forEach(visit);
    for (const p of d.purchases)
      if (p.taskId && !d.tasks.some((t) => t.id === p.taskId && t.projectId === p.projectId))
        ctx.addIssue({ code: 'custom', message: '采购的任务关联无效' });
  });
export type Project = z.infer<typeof projectSchema>;
export type Trade = z.infer<typeof tradeSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Note = z.infer<typeof noteSchema>;
export type Purchase = z.infer<typeof purchaseSchema>;
export type Data = z.infer<typeof dataSchema>;
export const emptyData = (): Data => ({
  version: 1,
  projects: [],
  trades: [],
  tasks: [],
  notes: [],
  purchases: [],
  recentColors: [],
});
export const palette = [
  '#8c9a86',
  '#648b9c',
  '#bda474',
  '#8b88a6',
  '#6e9989',
  '#c18e80',
  '#8c9cb5',
  '#72836b',
];
export const tradeNames = [
  '现场拆改',
  '水电改造',
  '防水与闭水试验',
  '墙地砖铺贴',
  '木工吊顶',
  '墙面油漆',
  '安装',
  '竣工验收',
];
export function defaultTrades(projectId: string): Trade[] {
  return tradeNames.map((name, i) => ({
    id: id(),
    projectId,
    name,
    color: palette[i],
    defaultColor: palette[i],
    order: i,
  }));
}
export const newProject = (): Project => ({
  id: id(),
  name: '',
  address: '',
  owner: '',
  manager: '',
  status: '施工中',
  start: today(),
  end: plus(today(), 59),
  actualStart: '',
  actualEnd: '',
  notes: '',
  archived: false,
  updatedAt: new Date().toISOString(),
});
export function projectRange(d: Data, p: Project): [string, string] {
  const ts = d.tasks.filter((t) => t.projectId === p.id);
  return [
    [p.start, ...ts.map((t) => t.start)].sort()[0],
    [p.end, ...ts.map((t) => t.end)].sort().at(-1)!,
  ];
}
export function rawPurchaseDue(p: Purchase, d: Data) {
  const t =
    p.deadlineMode !== 'fixed' &&
    d.tasks.find((t) => t.id === p.taskId && t.projectId === p.projectId);
  return t ? plus(t.start, -p.leadDays) : p.due;
}
export function purchaseCeiling(p: Purchase, d: Data) {
  return p.approvedDue ?? p.originalDue ?? rawPurchaseDue(p, d);
}
export function purchaseDue(p: Purchase, d: Data) {
  const planned = rawPurchaseDue(p, d);
  return [planned, purchaseCeiling(p, d)].sort()[0];
}
export const purchaseComplete = (p: Purchase) => p.status === '已完成' || p.status === '已到货';
export const projectStatus = (status: Project['status']) =>
  status === '筹备中' || status === '进行中' ? '施工中' : status;
export function remainingTime(due: string, now = today()) {
  const n = distance(now, due);
  return n === 0 ? '今天截止' : n > 0 ? `剩余 ${n} 天` : `已逾期 ${-n} 天`;
}
// Add a baseline to legacy records in memory, never clear or replace the database.
// The baseline is the effective deadline at first read by this version; unavailable older history is not invented.
export function prepareWorkspace(data: Data): Data {
  return {
    ...data,
    purchases: data.purchases.map((p) =>
      p.originalDue
        ? p
        : {
            ...p,
            originalDue: rawPurchaseDue(p, data),
            deadlineMode: p.taskId ? ('linked' as const) : ('fixed' as const),
          },
    ),
  };
}
export function procurementView(data: Data, projectId?: string, now = today()) {
  const all = data.purchases
    .filter((p) => !projectId || p.projectId === projectId)
    .sort(
      (a, b) =>
        purchaseDue(a, data).localeCompare(purchaseDue(b, data)) || a.id.localeCompare(b.id),
    );
  const pending = all.filter((p) => !purchaseComplete(p));
  return {
    all,
    pending,
    today: pending.filter((p) => purchaseDue(p, data) <= now),
    upcoming: pending.filter(
      (p) => purchaseDue(p, data) >= now && purchaseDue(p, data) <= plus(now, 15),
    ),
    overdue: pending.filter((p) => purchaseDue(p, data) < now),
  };
}
export const noteDue = (n: Note) => n.date || n.reminder;
export function todayNotes(data: Data, projectId?: string, now = today()) {
  return data.notes.filter(
    (n) =>
      (!projectId || n.projectId === projectId) &&
      !!noteDue(n) &&
      (!n.done ? noteDue(n) <= now : noteDue(n) === now),
  );
}
export const isHistorical = (p: Project) => p.archived || p.status === '已完工';
export function stats(d: Data, now = today()) {
  const active = new Set(d.projects.filter((p) => !isHistorical(p)).map((p) => p.id));
  const visible = {
    ...d,
    purchases: d.purchases.filter((p) => active.has(p.projectId)),
    notes: d.notes.filter((n) => active.has(n.projectId)),
  };
  const procurement = procurementView(visible, undefined, now);
  const purchases = procurement.pending;
  return {
    total: d.projects.length,
    ongoing: d.projects.filter((p) => active.has(p.id) && projectStatus(p.status) === '施工中')
      .length,
    todos:
      todayNotes(visible, undefined, now).filter((n) => !n.done).length + procurement.today.length,
    upcoming: purchases.filter(
      (p) => purchaseDue(p, d) >= now && purchaseDue(p, d) <= plus(now, 15),
    ).length,
    overduePurchases: purchases.filter((p) => purchaseDue(p, d) < now).length,
    overdueTasks: d.tasks.filter(
      (t) => active.has(t.projectId) && t.status !== '已完成' && t.end < now,
    ).length,
  };
}
export function removeProject(d: Data, pid: string): Data {
  return {
    ...d,
    projects: d.projects.filter((p) => p.id !== pid),
    trades: d.trades.filter((x) => x.projectId !== pid),
    tasks: d.tasks.filter((x) => x.projectId !== pid),
    notes: d.notes.filter((x) => x.projectId !== pid),
    purchases: d.purchases.filter((x) => x.projectId !== pid),
  };
}
export function copyProject(d: Data, source: Project): { data: Data; project: Project } {
  const project = {
    ...source,
    id: id(),
    name: `${source.name}（副本）`.slice(0, 100),
    archived: false,
    updatedAt: new Date().toISOString(),
  };
  const tradeMap = new Map(
    d.trades.filter((x) => x.projectId === source.id).map((x) => [x.id, id()]),
  );
  const taskMap = new Map(
    d.tasks.filter((x) => x.projectId === source.id).map((x) => [x.id, id()]),
  );
  const groups = new Map(
    d.tasks
      .filter((t) => t.projectId === source.id)
      .map((t) => [t.groupId ?? t.id, taskMap.get(t.groupId ?? t.id) ?? id()]),
  );
  return {
    project,
    data: {
      ...d,
      projects: [...d.projects, project],
      trades: [
        ...d.trades,
        ...d.trades
          .filter((x) => x.projectId === source.id)
          .map((x) => ({ ...x, id: tradeMap.get(x.id)!, projectId: project.id })),
      ],
      tasks: [
        ...d.tasks,
        ...d.tasks
          .filter((x) => x.projectId === source.id)
          .map((x) => ({
            ...x,
            id: taskMap.get(x.id)!,
            ...(x.groupId ? { groupId: groups.get(x.groupId)! } : {}),
            ...(x.dependsOn ? { dependsOn: x.dependsOn.map((dep) => taskMap.get(dep)!) } : {}),
            tradeId: tradeMap.get(x.tradeId)!,
            projectId: project.id,
          })),
      ],
      notes: [
        ...d.notes,
        ...d.notes
          .filter((x) => x.projectId === source.id)
          .map((x) => ({
            ...x,
            id: id(),
            projectId: project.id,
            ...(x.taskId ? { taskId: taskMap.get(x.taskId)! } : {}),
          })),
      ],
      purchases: [
        ...d.purchases,
        ...d.purchases
          .filter((x) => x.projectId === source.id)
          .map((x) => ({
            ...x,
            id: id(),
            projectId: project.id,
            taskId: taskMap.get(x.taskId) ?? '',
          })),
      ],
    },
  };
}
// Tasks are assigned separate vertical lanes when their dates overlap within a trade.
export function lanes(tasks: Task[]): Task[][] {
  const rows: Task[][] = [];
  for (const t of [...tasks].sort(
    (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
  )) {
    const row = rows.find((r) => r.every((x) => x.end < t.start || x.start > t.end));
    if (row) row.push(t);
    else rows.push([t]);
  }
  return rows.length ? rows : [[]];
}
export function parseBackup(input: unknown): Data {
  const parsed = dataSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .slice(0, 3)
        .map((x) => `${x.path.join('.')}：${x.message}`)
        .join('；'),
    );
  return parsed.data;
}

export function usedNames(data: Data): string[] {
  return [
    ...new Set(
      [
        ...data.projects.flatMap((p) => [p.manager]),
        ...data.tasks.map((t) => t.owner),
        ...[...data.projects, ...data.trades, ...data.tasks].flatMap((x) =>
          x.personnel ? Object.values(x.personnel) : [],
        ),
      ]
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && n.length <= 100),
    ),
  ];
}
export function rememberNames(data: Data, people?: Personnel, previous?: Personnel): Data {
  if (!people) return data;
  return {
    ...data,
    nameHistory: [
      ...new Set([
        ...(data.nameHistory ?? usedNames(data)),
        ...Object.entries(people)
          .filter(([role, value]) => !previous || previous[role as keyof Personnel] !== value)
          .map(([, n]) => n.trim())
          .filter((n) => n.length > 0 && n.length <= 100),
      ]),
    ].slice(-2000),
  };
}
// Array order is the canonical project order: older backups already have a stable order.
export function reorderProjects(
  data: Data,
  source: string,
  before: string | null,
  scope: string[],
): Data {
  const item = data.projects.find((p) => p.id === source);
  if (!item || !scope.includes(source) || source === before) return data;
  const rest = data.projects.filter((p) => p.id !== source);
  const last = rest.reduce((last, p, i) => (scope.includes(p.id) ? i : last), -1);
  const index =
    before === null ? last + 1 : rest.findIndex((p) => p.id === before && scope.includes(p.id));
  if (index < 0) return data;
  rest.splice(index, 0, item);
  return { ...data, projects: rest };
}
