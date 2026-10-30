import { canonical } from './history';
import { dataSchema, type Data } from './model';
export type WorkspaceConflict = {
  key: string;
  collection: string;
  id: string;
  field: string;
  base: unknown;
  local: unknown;
  remote: unknown;
};
export type MergeChoices = Record<string, 'local' | 'remote'>;
const collections = [
  'projects',
  'trades',
  'tasks',
  'notes',
  'purchases',
  'people',
  'dictionaries',
] as const;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Three-way intent merge. Unchanged fields never overwrite the current server value. */
export function mergeWorkspace(base: Data, local: Data, remote: Data, choices: MergeChoices = {}) {
  const conflicts: WorkspaceConflict[] = [];
  const conflict = (
    collection: string,
    id: string,
    field: string,
    b: unknown,
    l: unknown,
    r: unknown,
  ) => {
    const key = JSON.stringify([collection, id, field]);
    if (choices[key]) return choices[key] === 'local' ? l : r;
    conflicts.push({ key, collection, id, field, base: b, local: l, remote: r });
    return l;
  };
  const value = (
    b: unknown,
    l: unknown,
    r: unknown,
    collection: string,
    id: string,
    field: string,
  ): unknown => {
    if (same(l, b)) return r;
    if (same(r, b) || same(l, r)) return l;
    // Project updatedAt is UI metadata, not a user field or an audit timestamp.
    if (
      collection === 'projects' &&
      field === 'updatedAt' &&
      typeof l === 'string' &&
      typeof r === 'string'
    )
      return l > r ? l : r;
    if (object(b) && object(l) && object(r)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const merged = value(b[k], l[k], r[k], collection, id, field ? field + '.' + k : k);
        if (merged !== undefined) out[k] = merged;
      }
      return out;
    }
    // These arrays are sets by business definition; preserve independently added/removed members.
    if (
      ['nameHistory', 'recentColors', 'staffIds', 'dependsOn', 'tradeIds'].includes(field) &&
      [b, l, r].every(
        (x) => x === undefined || (Array.isArray(x) && x.every((y) => typeof y === 'string')),
      )
    ) {
      const bs = (b || []) as string[],
        ls = (l || []) as string[],
        rs = (r || []) as string[];
      const all = [...new Set([...rs, ...ls])];
      const merged = all.filter((x) =>
        bs.includes(x) ? ls.includes(x) && rs.includes(x) : ls.includes(x) || rs.includes(x),
      );
      return field === 'recentColors'
        ? merged.slice(-12)
        : field === 'nameHistory'
          ? merged.slice(-2000)
          : merged;
    }
    return conflict(collection, id, field, b, l, r);
  };
  const result: Record<string, unknown> = { ...remote };
  for (const collection of collections) {
    if (
      base[collection] === undefined &&
      local[collection] === undefined &&
      remote[collection] === undefined
    )
      continue;
    const b = base[collection] || [],
      l = local[collection] || [],
      r = remote[collection] || [];
    const bm = new Map(b.map((x) => [x.id, x])),
      lm = new Map(l.map((x) => [x.id, x])),
      rm = new Map(r.map((x) => [x.id, x]));
    const merged = new Map<string, unknown>();
    for (const id of new Set([...bm.keys(), ...lm.keys(), ...rm.keys()])) {
      const bv = bm.get(id),
        lv = lm.get(id),
        rv = rm.get(id);
      const recordChoice = choices[JSON.stringify([collection, id, '$record'])];
      const next = recordChoice
        ? recordChoice === 'local'
          ? lv
          : rv
        : (!bv && lv && rv && !same(lv, rv)) ||
            (bv && (!lv || !rv) && !same(lv, bv) && !same(rv, bv) && !same(lv, rv))
          ? conflict(collection, id, '$record', bv, lv, rv)
          : value(bv, lv, rv, collection, id, '');
      if (next !== undefined) merged.set(id, next);
    }
    const ids = (xs: typeof b) => xs.map((x) => x.id).filter((id) => merged.has(id));
    let order = ids(r);
    if (collection === 'projects' || collection === 'people') {
      const common = b.map((x) => x.id).filter((id) => lm.has(id) && rm.has(id));
      const ordered = (xs: typeof b) => xs.map((x) => x.id).filter((id) => common.includes(id));
      const bo = ordered(b),
        lo = ordered(l),
        ro = ordered(r);
      if (!same(lo, bo)) {
        if (!same(ro, bo) && !same(lo, ro))
          order = conflict(collection, '$order', 'order', bo, ids(l), ids(r)) as string[];
        else order = ids(l);
      }
    }
    result[collection] = [...new Set([...order, ...ids(l), ...merged.keys()])].map((id) =>
      merged.get(id),
    );
  }
  for (const field of ['nameHistory', 'recentColors'] as const) {
    const next = value(base[field], local[field], remote[field], 'workspace', '', field);
    if (next !== undefined) result[field] = next;
  }
  // Individually valid date/relationship edits can make an invalid combined graph. Escalate
  // conservatively to explicit record choices; never silently drop a child or resurrect a parent.
  if (!conflicts.length && !dataSchema.safeParse(result).success) {
    for (const collection of collections) {
      const b = new Map((base[collection] || []).map((x) => [x.id, x]));
      const l = new Map((local[collection] || []).map((x) => [x.id, x]));
      const r = new Map((remote[collection] || []).map((x) => [x.id, x]));
      for (const id of new Set([...b.keys(), ...l.keys()])) {
        if (!same(b.get(id), l.get(id)) && !same(l.get(id), r.get(id))) {
          const key = JSON.stringify([collection, id, '$record']);
          if (!choices[key]) conflict(collection, id, '$record', b.get(id), l.get(id), r.get(id));
        }
      }
    }
  }
  return { data: result as Data, conflicts };
}
