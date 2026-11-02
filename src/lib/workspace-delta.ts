import { canonical } from './history';
import type { Data } from './model';
export const deltaCollections = [
  'projects',
  'trades',
  'tasks',
  'notes',
  'purchases',
  'people',
  'dictionaries',
] as const;
export type DeltaChange = {
  collection: (typeof deltaCollections)[number] | 'workspace';
  id: string;
  kind: 'record' | 'order' | 'value';
  before: unknown;
  after: unknown;
  proof?: string;
};
export type WorkspaceDelta = {
  protocol: 3;
  revision: number;
  requestId: string;
  changes: DeltaChange[];
};
export const deltaKey = (change: Pick<DeltaChange, 'collection' | 'kind' | 'id'>) =>
  JSON.stringify([change.collection, change.kind, change.id]);
export function deltaResources(data: Data) {
  const resources: Omit<DeltaChange, 'before' | 'proof'>[] = [];
  for (const collection of deltaCollections) {
    for (const row of data[collection] ?? [])
      resources.push({ collection, kind: 'record', id: row.id, after: row });
    if (collection === 'projects' || collection === 'people')
      resources.push({
        collection,
        kind: 'order',
        id: '',
        after: (data[collection] ?? []).map((x) => x.id),
      });
  }
  for (const id of ['nameHistory', 'recentColors'] as const)
    resources.push({ collection: 'workspace', kind: 'value', id, after: data[id] ?? null });
  return resources;
}
export function makeWorkspaceDelta(
  base: Data,
  data: Data,
  revision: number,
  requestId: string,
  proofs: Record<string, string>,
): WorkspaceDelta {
  const old = new Map(deltaResources(base).map((x) => [deltaKey(x), x]));
  const next = new Map(deltaResources(data).map((x) => [deltaKey(x), x]));
  const changes: DeltaChange[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(key),
      b = next.get(key);
    if (canonical(a?.after) === canonical(b?.after)) continue;
    const ref = b ?? a!;
    changes.push({
      collection: ref.collection,
      kind: ref.kind,
      id: ref.id,
      before: a?.after ?? null,
      after: b?.after ?? null,
      ...(a ? { proof: proofs[key] } : {}),
    });
  }
  return { protocol: 3, revision, requestId, changes };
}
// Both sides are reconstructed separately. Untouched remote fields remain remote.
export function applyDeltaSide(
  current: Data,
  changes: DeltaChange[],
  side: 'before' | 'after',
): Data {
  const out = structuredClone(current);
  for (const change of changes.filter((x) => x.kind === 'record')) {
    const key = change.collection as (typeof deltaCollections)[number];
    const rows = (out[key] ?? []).filter((x) => x.id !== change.id);
    const original = (out[key] ?? []).findIndex((x) => x.id === change.id);
    const value = change[side];
    if (value !== null) rows.splice(original < 0 ? rows.length : original, 0, value as any);
    (out as any)[key] = rows;
  }
  for (const change of changes.filter((x) => x.kind !== 'record')) {
    const value = change[side];
    if (change.kind === 'value') {
      (out as any)[change.id] = value ?? undefined;
      continue;
    }
    const key = change.collection as (typeof deltaCollections)[number];
    const rows = out[key] ?? [];
    const order = value as string[];
    const map = new Map(rows.map((x) => [x.id, x]));
    const ids = new Set(order);
    (out as any)[key] = [
      ...order.flatMap((id) => (map.has(id) ? [map.get(id)!] : [])),
      ...rows.filter((x) => !ids.has(x.id)),
    ];
  }
  return out;
}
