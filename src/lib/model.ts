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
export const projectSchema = z
  .object({
    id: uid,
    name,
    address: text,
    owner: text,
    manager: text,
    status: z.enum(['筹备中', '进行中', '已完工', '暂停']),
    start: date,
    end: date,
    actualStart: optionalDate,
    actualEnd: optionalDate,
    notes: text,
    archived: z.boolean(),
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
    status: z.enum(['待采购', '已下单', '已到货']),
    owner: text,
    notes: text,
  })
  .strict();
export const dataSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(projectSchema).max(500),
    trades: z.array(tradeSchema).max(5000),
    tasks: z.array(taskSchema).max(20000),
    notes: z.array(noteSchema).max(20000),
    purchases: z.array(purchaseSchema).max(20000),
    recentColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(12),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const list of [d.projects, d.trades, d.tasks, d.notes, d.purchases]) {
      if (new Set(list.map((x) => x.id)).size !== list.length)
        ctx.addIssue({ code: 'custom', message: '备份中存在重复 ID' });
    }
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
  status: '筹备中',
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
export function purchaseDue(p: Purchase, d: Data) {
  const t = d.tasks.find((t) => t.id === p.taskId && t.projectId === p.projectId);
  return t ? plus(t.start, -p.leadDays) : p.due;
}
export function stats(d: Data, now = today()) {
  const active = new Set(d.projects.filter((p) => !p.archived).map((p) => p.id));
  const purchases = d.purchases.filter((p) => active.has(p.projectId) && p.status !== '已到货');
  return {
    total: active.size,
    ongoing: d.projects.filter((p) => active.has(p.id) && p.status === '进行中').length,
    todos: d.notes.filter(
      (n) => active.has(n.projectId) && !n.done && (n.date === now || n.reminder === now),
    ).length,
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
            tradeId: tradeMap.get(x.tradeId)!,
            projectId: project.id,
          })),
      ],
      notes: [
        ...d.notes,
        ...d.notes
          .filter((x) => x.projectId === source.id)
          .map((x) => ({ ...x, id: id(), projectId: project.id })),
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
