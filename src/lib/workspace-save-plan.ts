import { canonical } from './history';
import { dataSchema, type Data } from './model';
import { mergeWorkspace, type WorkspaceConflict } from './workspace-merge';

export const workspaceCollections = [
  'projects',
  'trades',
  'tasks',
  'notes',
  'purchases',
  'people',
  'dictionaries',
] as const;
type Collection = (typeof workspaceCollections)[number];
export type SaveHold = {
  collection: Collection | 'workspace';
  id: string;
  kind: 'validation' | 'conflict' | 'dependency';
  reason: string;
};
export type ValidationIssue = { path: (string | number)[]; code: string; message: string };
export const resourceKey = (item: { collection: string; id: string }) =>
  JSON.stringify([item.collection, item.id]);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function resourceValue(data: Data, item: Pick<SaveHold, 'collection' | 'id'>): unknown {
  if (item.collection === 'workspace') return data[item.id as 'nameHistory' | 'recentColors'];
  const rows = data[item.collection] ?? [];
  return item.id === '$order' ? rows.map((x) => x.id) : rows.find((x) => x.id === item.id);
}
export function changedResources(base: Data, data: Data): Pick<SaveHold, 'collection' | 'id'>[] {
  const changes: Pick<SaveHold, 'collection' | 'id'>[] = [];
  for (const collection of workspaceCollections) {
    const before = base[collection] ?? [],
      after = data[collection] ?? [];
    const bm = new Map(before.map((x) => [x.id, x])),
      am = new Map(after.map((x) => [x.id, x]));
    for (const id of new Set([...bm.keys(), ...am.keys()])) {
      const a = bm.get(id),
        b = am.get(id);
      // This stamp is UI metadata, not an independent change that can block a project.
      const value = (row: unknown) =>
        collection === 'projects' && row ? { ...(row as object), updatedAt: '' } : row;
      if (!same(value(a), value(b))) changes.push({ collection, id });
    }
    if (collection === 'people' || collection === 'projects') {
      const common = new Set(before.filter((x) => am.has(x.id)).map((x) => x.id));
      if (
        !same(
          before.filter((x) => common.has(x.id)).map((x) => x.id),
          after.filter((x) => common.has(x.id)).map((x) => x.id),
        )
      )
        changes.push({ collection, id: '$order' });
    }
  }
  for (const id of ['nameHistory', 'recentColors'] as const)
    if (!same(base[id], data[id])) changes.push({ collection: 'workspace', id });
  return changes;
}
/** Remove only the withheld intent. The original draft and all its records stay untouched. */
export function withholdResources(
  data: Data,
  base: Data,
  holds: Pick<SaveHold, 'collection' | 'id'>[],
): Data {
  const out = { ...data };
  for (const collection of workspaceCollections) {
    const held = holds.filter((x) => x.collection === collection);
    if (!held.length) continue;
    const before: { id: string }[] = base[collection] ?? [];
    let rows: { id: string }[] = [...(data[collection] ?? [])];
    for (const item of held.filter((x) => x.id !== '$order')) {
      const prior = before.find((x) => x.id === item.id),
        index = rows.findIndex((x) => x.id === item.id);
      if (index >= 0) rows = rows.flatMap((x, i) => (i === index ? (prior ? [prior] : []) : [x]));
      else if (prior) rows.splice(Math.min(before.indexOf(prior), rows.length), 0, prior);
    }
    if (held.some((x) => x.id === '$order')) {
      const map = new Map(rows.map((x) => [x.id, x]));
      const beforeIds = new Set(before.map((x) => x.id));
      rows = [
        ...before.flatMap((x) => (map.has(x.id) ? [map.get(x.id)!] : [])),
        ...rows.filter((x) => !beforeIds.has(x.id)),
      ];
    }
    Object.assign(out, { [collection]: rows });
  }
  for (const item of holds.filter((x) => x.collection === 'workspace')) {
    const key = item.id as 'nameHistory' | 'recentColors';
    if (base[key] === undefined) delete out[key];
    else Object.assign(out, { [key]: base[key] });
  }
  return out;
}
/** Advance untouched records together with their baseline. A pending record's
 * old fields must not be rebased under local edits and mistaken for new intent. */
export function reconcileWorkspaceView(base: Data, local: Data, remote: Data) {
  const dirty = changedResources(base, local);
  let data = withholdResources(remote, local, dirty),
    nextBase = withholdResources(remote, base, dirty);
  const repaired = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    if (dataSchema.safeParse(data).success && dataSchema.safeParse(nextBase).success)
      return { data, base: nextBase };
    const repair = new Map<string, Pick<SaveHold, 'collection' | 'id'>>();
    for (const [candidate, source] of [
      [data, local],
      [nextBase, base],
    ])
      for (const issue of referenceIssues(candidate)) {
        const targets = same(
          resourceValue(candidate, issue.owner),
          resourceValue(source, issue.owner),
        )
          ? issue.parents
          : [issue.owner];
        for (const target of targets)
          if (!repaired.has(resourceKey(target))) repair.set(resourceKey(target), target);
      }
    if (!repair.size) break;
    const targets = [...repair.values()];
    // Always restore both sides together. Hiding a remote child only in the
    // visible draft would otherwise look like a new local deletion.
    data = withholdResources(data, local, targets);
    nextBase = withholdResources(nextBase, base, targets);
    targets.forEach((x) => repaired.add(resourceKey(x)));
  }
  return { data: local, base };
}
export function holdsForFailure(
  base: Data,
  data: Data,
  reason: string,
  issues: ValidationIssue[] = [],
): SaveHold[] {
  const changes = changedResources(base, data),
    keys = new Set<string>();
  for (const issue of issues) {
    const [root, collection, index] = issue.path;
    if (root !== 'data') continue;
    if (workspaceCollections.includes(collection as Collection) && typeof index === 'number') {
      const id = (data[collection as Collection] ?? [])[index]?.id;
      if (id) keys.add(resourceKey({ collection: collection as Collection, id }));
    } else if (collection === 'nameHistory' || collection === 'recentColors')
      keys.add(resourceKey({ collection: 'workspace', id: collection }));
  }
  const located = changes.filter((x) => keys.has(resourceKey(x)));
  return (located.length ? located : changes).map((x) => ({ ...x, kind: 'validation', reason }));
}
// A new person and their new dictionary/assignment are dependent intents. Do not
// send dangling references merely to save an unrelated purchase or memo.
function referenceIssues(data: Data) {
  type Scope = Pick<SaveHold, 'collection' | 'id'>;
  type Ref = Scope & { projectId?: string; kind?: string };
  const maps = new Map(
    workspaceCollections.map((key) => [
      key,
      new Map((data[key] ?? []).map((row) => [row.id, row as unknown as Record<string, unknown>])),
    ]),
  );
  const issues: { owner: Scope; parents: Ref[] }[] = [];
  for (const collection of workspaceCollections)
    for (const [id, row] of maps.get(collection)!) {
      const parents: Ref[] = [];
      const add = (target: Collection, value: unknown, extra: Partial<Ref> = {}) => {
        if (typeof value === 'string' && value)
          parents.push({ collection: target, id: value, ...extra });
      };
      if (collection === 'people') {
        add('dictionaries', row.categoryId, { kind: 'category' });
        if (Array.isArray(row.tradeIds))
          row.tradeIds.forEach((key) => add('dictionaries', key, { kind: 'trade' }));
      }
      if (Array.isArray(row.staffIds)) row.staffIds.forEach((key) => add('people', key));
      add('projects', row.projectId);
      const projectId = typeof row.projectId === 'string' ? row.projectId : undefined;
      if (collection === 'tasks') {
        add('trades', row.tradeId, { projectId });
        if (Array.isArray(row.dependsOn))
          row.dependsOn.forEach((key) => add('tasks', key, { projectId }));
      }
      if (collection === 'notes' || collection === 'purchases')
        add('tasks', row.taskId, { projectId });
      const missing = parents.filter((ref) => {
        const target = maps.get(ref.collection as Collection)?.get(ref.id);
        return (
          !target ||
          (ref.projectId !== undefined && target.projectId !== ref.projectId) ||
          (ref.kind !== undefined && target.kind !== ref.kind)
        );
      });
      if (missing.length) issues.push({ owner: { collection, id }, parents: missing });
    }
  return issues;
}
function relevantGraphConflicts(result: { data: Data; conflicts: WorkspaceConflict[] }) {
  const issues = referenceIssues(result.data);
  if (!issues.length) return result;
  const related = new Set(issues.flatMap((x) => [x.owner, ...x.parents]).map(resourceKey));
  const conflicts = result.conflicts.filter((x) => !x.graph || related.has(resourceKey(x)));
  return conflicts.length ? { ...result, conflicts } : result;
}
export function planWorkspaceSave(
  base: Data,
  local: Data,
  remote: Data,
  previous: SaveHold[] = [],
) {
  const full = relevantGraphConflicts(mergeWorkspace(base, local, remote));
  const conflictKeys = new Set(full.conflicts.map(resourceKey));
  const held = new Map(
    previous
      .filter(
        (x) =>
          x.kind !== 'dependency' &&
          !same(resourceValue(local, x), resourceValue(remote, x)) &&
          (x.kind !== 'conflict' || conflictKeys.has(resourceKey(x))),
      )
      .map((x) => [resourceKey(x), x]),
  );
  for (const item of full.conflicts)
    held.set(resourceKey(item), {
      collection: item.collection as Collection,
      id: item.id,
      kind: 'conflict',
      reason: '相同字段或关联已被修改，请核对冲突',
    });
  for (let pass = 0; pass < 32; pass++) {
    const holds = [...held.values()],
      view = withholdResources(local, base, holds);
    const dependencies = referenceIssues(view)
      .map((x) => x.owner)
      .filter((x) => !held.has(resourceKey(x)));
    if (dependencies.length) {
      for (const x of dependencies)
        held.set(resourceKey(x), { ...x, kind: 'dependency', reason: '等待关联记录先完成保存' });
      continue;
    }
    const merged = relevantGraphConflicts(mergeWorkspace(base, view, remote));
    if (!merged.conflicts.length && dataSchema.safeParse(merged.data).success)
      return { data: merged.data, view, holds, conflicts: full.conflicts };
    let added = false;
    for (const x of merged.conflicts) {
      const key = resourceKey(x);
      if (!held.has(key)) {
        held.set(key, {
          collection: x.collection as Collection,
          id: x.id,
          kind: conflictKeys.has(key) ? 'conflict' : 'dependency',
          reason: '关联或字段冲突，原草稿保留',
        });
        added = true;
      }
    }
    if (!added) throw Error('关联尚无法安全分离，已保留完整草稿，请核对相关记录');
  }
  throw Error('关联层级过深，已保留完整草稿，请核对相关记录');
}
export function releaseCorrectedHolds(before: Data, after: Data, holds: SaveHold[]) {
  return holds.filter(
    (x) =>
      x.kind === 'conflict' ||
      (x.kind !== 'dependency' && same(resourceValue(before, x), resourceValue(after, x))),
  );
}
export function pendingSaveMessage(holds: SaveHold[], data: Data, base?: Data) {
  const names: Record<string, string> = {
    projects: '项目',
    trades: '施工工序',
    tasks: '施工任务',
    notes: '事项',
    purchases: '采购',
    people: '人员',
    dictionaries: '人员工种',
    workspace: '工作空间设置',
  };
  return (
    holds
      .filter((x) => x.kind !== 'dependency')
      .slice(0, 4)
      .map((x) => {
        const value = (resourceValue(data, x) ?? (base && resourceValue(base, x))) as
          { name?: string; title?: string; label?: string } | undefined;
        const label =
          x.id === '$order' ? '排序' : value?.name || value?.title || value?.label || x.id;
        return `${names[x.collection]}「${label}」：${x.reason}`;
      })
      .join('；') + '。相关修改已保留为草稿，其他记录可以继续自动保存。'
  );
}
