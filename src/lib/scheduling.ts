import { distance, duration, parseBackup, plus, type Data, type Task } from './model';
export type TaskChange = { before: Task; after: Task };
export type ScheduleProposal = {
  base: Data;
  current: Data;
  shifted: Data;
  affected: TaskChange[];
  mergedIds: string[];
  inferred: boolean;
  shiftError?: string;
};
const logicalId = (t: Task) => t.groupId ?? t.id;
// Merge only explicitly linked segments. Equal names never establish a logical relationship.
function mergeSegments(data: Data, changed: Task): { data: Data; removed: string[] } {
  let survivor = { ...changed },
    removed: string[] = [];
  let found = true;
  while (found) {
    found = false;
    for (const t of data.tasks) {
      if (
        t.id === survivor.id ||
        removed.includes(t.id) ||
        t.projectId !== survivor.projectId ||
        t.tradeId !== survivor.tradeId ||
        logicalId(t) !== logicalId(survivor)
      )
        continue;
      if (t.start <= plus(survivor.end, 1) && t.end >= plus(survivor.start, -1)) {
        removed.push(t.id);
        survivor = {
          ...survivor,
          start: [t.start, survivor.start].sort()[0],
          end: [t.end, survivor.end].sort().at(-1)!,
          notes: [
            ...new Set(
              [
                survivor.notes,
                t.notes,
                `合并段记录：${t.name}（${t.start} — ${t.end}；${t.status}${t.owner ? '；负责人 ' + t.owner : ''}${t.personnel ? '；人员 ' + Object.values(t.personnel).filter(Boolean).join(' / ') : ''}）`,
              ].filter(Boolean),
            ),
          ].join('\n'),
          dependsOn: [...new Set([...(survivor.dependsOn ?? []), ...(t.dependsOn ?? [])])].filter(
            (dep) => dep !== survivor.id && !removed.includes(dep),
          ),
        };
        found = true;
      }
    }
  }
  const remap = (dep: string) => (removed.includes(dep) ? survivor.id : dep);
  return {
    removed,
    data: {
      ...data,
      tasks: data.tasks
        .filter((t) => !removed.includes(t.id))
        .map((t) => {
          const value = t.id === survivor.id ? survivor : t;
          return {
            ...value,
            ...(value.dependsOn
              ? {
                  dependsOn: [...new Set(value.dependsOn.map(remap))].filter(
                    (dep) => dep !== value.id,
                  ),
                }
              : {}),
          };
        }),
      purchases: data.purchases.map((p) => ({ ...p, taskId: remap(p.taskId) })),
      notes: data.notes.map((n) => (n.taskId ? { ...n, taskId: remap(n.taskId) } : n)),
    },
  };
}
function expandProject(data: Data, pid: string): Data {
  const tasks = data.tasks.filter((t) => t.projectId === pid);
  return {
    ...data,
    projects: data.projects.map((p) =>
      p.id === pid
        ? {
            ...p,
            start: [p.start, ...tasks.map((t) => t.start)].sort()[0],
            end: [p.end, ...tasks.map((t) => t.end)].sort().at(-1)!,
          }
        : p,
    ),
  };
}
export function proposeTaskChange(base: Data, value: Task): ScheduleProposal {
  const old = base.tasks.find((t) => t.id === value.id);
  let current = {
    ...base,
    tasks: old ? base.tasks.map((t) => (t.id === value.id ? value : t)) : [...base.tasks, value],
  };
  let mergedIds: string[] = [];
  if (old && (old.start !== value.start || old.end !== value.end)) {
    const merged = mergeSegments(current, value);
    current = merged.data;
    mergedIds = merged.removed;
  }
  current = expandProject(current, value.projectId);
  parseBackup(current);
  const changed = current.tasks.find((t) => t.id === value.id)!;
  let shifted = { ...current, tasks: current.tasks.map((t) => ({ ...t })) };
  const order = new Map(base.trades.map((t) => [t.id, t.order]));
  let inferred = false;
  const original = new Map(base.tasks.map((t) => [t.id, t]));
  const dependsTransitively = (
    source: string,
    target: string,
    seen = new Set<string>(),
  ): boolean => {
    if (source === target) return true;
    if (seen.has(source)) return false;
    seen.add(source);
    return (original.get(source)?.dependsOn ?? []).some((dep) =>
      dependsTransitively(dep, target, seen),
    );
  };
  // Iterate a validated acyclic explicit graph; an ordered temporal heuristic is used only
  // for tasks without explicit dependencies. Existing overlaps are intentionally untouched.
  for (let pass = 0; pass < shifted.tasks.length; pass++) {
    let progressed = false;
    for (const t of shifted.tasks) {
      if (t.id === changed.id || t.projectId !== value.projectId || t.status === '已完成') continue;
      const was = original.get(t.id);
      if (!was) continue;
      let earliest = t.start;
      for (const parent of shifted.tasks) {
        if (parent.id === t.id || parent.projectId !== t.projectId) continue;
        // A surviving segment may represent several retired predecessors. Compare
        // against the predecessor each dependent actually referenced before merging.
        const baselines = [parent.id, ...(parent.id === changed.id ? mergedIds : [])]
          .map((id) => original.get(id))
          .filter((item): item is Task => !!item);
        const explicit = !!t.dependsOn?.includes(parent.id);
        const explicitGrowth =
          explicit &&
          baselines.some((before) => was.dependsOn?.includes(before.id) && parent.end > before.end);
        const ordered =
          !t.dependsOn?.length &&
          (order.get(t.tradeId) ?? 0) > (order.get(parent.tradeId) ?? 0) &&
          !baselines.some((before) => dependsTransitively(before.id, t.id)) &&
          (baselines.some(
            (before) =>
              parent.end > before.end && was.start > before.end && was.start <= parent.end,
          ) ||
            (!old &&
              parent.id === changed.id &&
              was.start >= changed.start &&
              was.start <= changed.end));
        if (explicitGrowth || ordered) {
          const next = plus(parent.end, 1);
          if (next > earliest) {
            earliest = next;
            if (ordered) inferred = true;
          }
        }
      }
      if (earliest > t.start) {
        t.start = earliest;
        t.end = plus(earliest, duration(was.start, was.end) - 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  shifted = expandProject(shifted, value.projectId);
  let shiftError: string | undefined;
  try {
    parseBackup(shifted);
  } catch (error) {
    shiftError = error instanceof Error ? error.message : String(error);
  }
  const affected = shifted.tasks
    .filter(
      (t) =>
        t.id !== changed.id &&
        original.has(t.id) &&
        (t.start !== original.get(t.id)!.start || t.end !== original.get(t.id)!.end),
    )
    .map((t) => ({ before: original.get(t.id)!, after: t }));
  return {
    base,
    current,
    shifted,
    affected,
    mergedIds,
    inferred,
    ...(shiftError ? { shiftError } : {}),
  };
}
export function reorderTrades(
  data: Data,
  pid: string,
  source: string,
  before: string | null,
): Data {
  const sorted = data.trades.filter((t) => t.projectId === pid).sort((a, b) => a.order - b.order);
  const item = sorted.find((t) => t.id === source);
  if (!item) return data;
  const rest = sorted.filter((t) => t.id !== source);
  const index = before === null ? rest.length : rest.findIndex((t) => t.id === before);
  if (index < 0) return data;
  rest.splice(index, 0, item);
  return {
    ...data,
    trades: data.trades.map((t) =>
      t.projectId === pid ? { ...t, order: rest.findIndex((g) => g.id === t.id) } : t,
    ),
  };
}
export function insertTrade(data: Data, trade: Data['trades'][number]): Data {
  const sorted = data.trades
    .filter((t) => t.projectId === trade.projectId)
    .sort((a, b) => a.order - b.order);
  sorted.splice(Math.min(trade.order, sorted.length), 0, trade);
  return {
    ...data,
    trades: [
      ...data.trades.filter((t) => t.projectId !== trade.projectId),
      ...sorted.map((t, i) => ({ ...t, order: i })),
    ],
  };
}
export function dateDelta(before: Task, after: Task) {
  return distance(before.end, after.end);
}
