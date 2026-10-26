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
export function staffWork(data: Data, personId: string, now = today()) {
  return data.projects.flatMap((project) => {
    const trades = data.trades.filter(
      (g) => g.projectId === project.id && g.staffIds?.includes(personId),
    );
    const tasks = data.tasks.filter(
      (t) =>
        t.projectId === project.id &&
        (t.staffIds?.includes(personId) || trades.some((g) => g.id === t.tradeId)),
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
  return (data.people ?? []).flatMap((person) => {
    const tasks = staffWork(data, person.id)
      .filter((w) => !isHistorical(w.project))
      .flatMap((w) =>
        w.tasks.filter((t) => t.status !== '已完成').map((task) => ({ task, project: w.project })),
      );
    const conflicts = [];
    for (let i = 0; i < tasks.length; i++)
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i],
          b = tasks[j];
        if (a.project.id === b.project.id || a.task.end < b.task.start || b.task.end < a.task.start)
          continue;
        conflicts.push({
          id: [person.id, a.task.id, b.task.id].join(':'),
          person,
          a,
          b,
          start: [a.task.start, b.task.start].sort()[1],
          end: [a.task.end, b.task.end].sort()[0],
        });
      }
    return conflicts;
  });
}
