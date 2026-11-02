import { dateOK, distance, isHistorical, today, type Data, type Project } from './model';
// A schedule is a forecast, never evidence of actual completion.
export function scheduleForecast(data: Data, project: Project) {
  const tasks = data.tasks.filter(
    (t) => t.projectId === project.id && dateOK(t.start) && dateOK(t.end) && t.end >= t.start,
  );
  const start = tasks.map((t) => t.start).sort()[0] ?? null;
  const end =
    tasks
      .map((t) => t.end)
      .sort()
      .at(-1) ?? null;
  const actual = project.status === '已完工' && dateOK(project.actualEnd);
  const finish = actual ? project.actualEnd : end;
  const delta = finish ? distance(project.end, finish) : null;
  const label =
    delta === null
      ? '待排期'
      : `${actual ? '实际' : '预计'}${delta > 0 ? `延期 ${delta} 天` : delta < 0 ? `提前 ${-delta} 天` : '按计划完工'}`;
  return {
    start,
    end,
    delta,
    actual,
    label: `${start && end ? `排期 ${start} — ${end} · ` : ''}${label}`,
  };
}
export function remainingSchedule(p: Pick<Project, 'status' | 'archived' | 'end'>, now = today()) {
  if (isHistorical(p as Project)) return '已完工';
  if (!p.end) return '剩余工期未设置';
  const n = distance(now, p.end);
  return n < 0
    ? `已超期 ${-n} 天`
    : n === 0
      ? '今日计划完工'
      : n <= 7
        ? `即将完工 · 剩余 ${n} 天`
        : `剩余 ${n} 天`;
}
export function ambiguousTaskStaff(data: Data, task: Data['tasks'][number]) {
  const stage = data.trades.find((g) => g.id === task.tradeId && g.projectId === task.projectId);
  return (
    !task.staffAssignment &&
    !!task.staffIds?.length &&
    !!stage?.staffIds?.length &&
    JSON.stringify([...task.staffIds].sort()) !== JSON.stringify([...stage.staffIds].sort())
  );
}
export function staffWork(data: Data, personId: string, now = today()) {
  return data.projects.flatMap((project) => {
    const trades = data.trades.filter(
      (g) => g.projectId === project.id && g.staffIds?.includes(personId),
    );
    const tasks = data.tasks.filter(
      (t) =>
        t.projectId === project.id &&
        !ambiguousTaskStaff(data, t) &&
        (t.staffAssignment !== 'inherit' && t.staffIds !== undefined
          ? t.staffIds.includes(personId)
          : trades.some((g) => g.id === t.tradeId)),
    );
    if (!project.staffIds?.includes(personId) && !trades.length && !tasks.length) return [];
    const start = tasks.length ? tasks.map((t) => t.start).sort()[0] : project.start;
    return [
      {
        project,
        trades,
        tasks,
        start,
        status: isHistorical(project) ? '已完工' : start > now ? '未进场' : '施工中',
      },
    ];
  });
}

export function staffConflicts(data: Data) {
  return (data.people ?? [])
    .filter((p) => p.active && !p.deleted && data.people!.filter((x) => x.id === p.id).length === 1)
    .flatMap((person) => {
      const tasks = staffWork(data, person.id)
        .filter((w) => !isHistorical(w.project) && w.project.status !== '暂停')
        .flatMap((w) =>
          w.tasks
            .filter(
              (t) => t.status !== '已完成' && dateOK(t.start) && dateOK(t.end) && t.end >= t.start,
            )
            .map((task) => ({ task, project: w.project })),
        );
      const conflicts = [];
      for (let i = 0; i < tasks.length; i++)
        for (let j = i + 1; j < tasks.length; j++) {
          const a = tasks[i],
            b = tasks[j];
          if (
            a.project.id === b.project.id ||
            a.task.end < b.task.start ||
            b.task.end < a.task.start
          )
            continue;
          conflicts.push({
            id: [person.id, a.task.id, b.task.id].join(':'),
            person,
            a,
            b,
            start: [a.task.start, b.task.start].sort()[1],
            end: [a.task.end, b.task.end].sort()[0],
            days:
              distance([a.task.start, b.task.start].sort()[1], [a.task.end, b.task.end].sort()[0]) +
              1,
          });
        }
      return conflicts;
    });
}

// Diagnostics only: never guess a missing identity or rewrite historical assignments.
export function staffAssignmentIssues(data: Data) {
  const people = data.people ?? [];
  const ambiguous = data.tasks
    .filter((t) => ambiguousTaskStaff(data, t))
    .map((t) => ({
      sourceId: t.id,
      sourceName: `${data.projects.find((p) => p.id === t.projectId)?.name ?? t.projectId} / ${t.name}`,
      personId: t.staffIds!.join('、'),
      reason:
        '历史任务人员与当前工种人员不一致，可能是旧复制关联；请在任务中确认跟随工种或独立分配，不作为已确认冲突',
    }));
  return [
    ...ambiguous,
    ...[...data.projects, ...data.trades, ...data.tasks].flatMap((source) =>
      (source.staffIds ?? []).flatMap((id) => {
        const matches = people.filter((p) => p.id === id);
        return matches.length === 1
          ? []
          : [
              {
                sourceId: source.id,
                sourceName: source.name,
                personId: id,
                reason: matches.length ? '人员ID重复，身份待确认' : '人员ID无对应档案，待确认映射',
              },
            ];
      }),
    ),
  ];
}
