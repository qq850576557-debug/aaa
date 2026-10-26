import { distance, plus, type Task } from './model';
export type GanttGroup = Task & { members: Task[] };
// Projection only: no records, references or metadata are removed from storage.
export function ganttGroups(tasks: Task[]): GanttGroup[] {
  const result: GanttGroup[] = [];
  const sorted = [...tasks].sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) ||
      a.tradeId.localeCompare(b.tradeId) ||
      a.start.localeCompare(b.start) ||
      a.id.localeCompare(b.id),
  );
  for (const task of sorted) {
    const last = result.at(-1);
    if (
      last &&
      last.projectId === task.projectId &&
      last.tradeId === task.tradeId &&
      task.start <= plus(last.end, 1)
    ) {
      last.end = [last.end, task.end].sort().at(-1)!;
      last.members.push(task);
      if (task.status !== '已完成') last.status = task.status;
    } else result.push({ ...task, members: [task] });
  }
  return result;
}
export function resizeGanttGroup(
  group: GanttGroup,
  next: Task,
  mode: 'move' | 'start' | 'end',
): Task[] {
  const delta = distance(group.start, next.start);
  const clamp = (d: string) => (d < next.start ? next.start : d > next.end ? next.end : d);
  return group.members.map((t) => {
    if (mode === 'move') return { ...t, start: plus(t.start, delta), end: plus(t.end, delta) };
    return {
      ...t,
      start: mode === 'start' && t.start === group.start ? next.start : clamp(t.start),
      end: mode === 'end' && t.end === group.end ? next.end : clamp(t.end),
    };
  });
}
