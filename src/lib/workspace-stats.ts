import { isHistorical, stats, type Data } from './model';
import type { WorkRecord } from './records';
/** Preserve existing metric rules, changing only the explicitly selected display scope. */
export function workspaceStats(data: Data, records: WorkRecord[], now: string, projectId?: string) {
  const scope = projectId
    ? {
        ...data,
        projects: data.projects.filter((p) => p.id === projectId),
        purchases: data.purchases.filter((p) => p.projectId === projectId),
        notes: data.notes.filter((p) => p.projectId === projectId),
      }
    : data;
  const base = stats(scope, now);
  return {
    ...base,
    todos:
      base.todos +
      records.filter(
        (r) =>
          !r.deleted &&
          r.nodeDate &&
          r.nodeDate <= now &&
          !['已完成', '已取消'].includes(r.status) &&
          scope.projects.some((p) => p.id === r.projectId && !isHistorical(p)),
      ).length,
  };
}
