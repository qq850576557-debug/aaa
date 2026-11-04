import { businessUndo, type UndoCommand } from './undo-manager';
import { canonical } from './history';
import {
  makeWorkspaceDelta,
  deltaResources,
  deltaKey,
  applyDeltaSide,
  type DeltaChange,
} from './workspace-delta';
import { parseBackup, type Data } from './model';
const meaningful = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(meaningful);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== 'updatedAt')
        .map(([k, v]) => [k, meaningful(v)]),
    );
  return v;
};
const effective = (changes: DeltaChange[]) =>
  changes.filter((c) => canonical(meaningful(c.before)) !== canonical(meaningful(c.after)));
export function applyUndoDelta(changes: DeltaChange[], current: Data, backwards: boolean): Data {
  const patch = effective(changes).map((c) =>
    backwards ? { ...c, before: c.after, after: c.before } : c,
  );
  const live = new Map(deltaResources(current).map((r) => [deltaKey(r), r.after]));
  for (const c of patch)
    if (canonical(meaningful(live.get(deltaKey(c)) ?? null)) !== canonical(meaningful(c.before)))
      throw Error('目标资料已有新修改，保留当前数据；请核对后手动调整。');
  return parseBackup(applyDeltaSide(current, patch, 'after'));
}
export function reverseWorkspace(expected: Data, desired: Data, current: Data): Data {
  return applyUndoDelta(makeWorkspaceDelta(expected, desired, 0, '', {}).changes, current, false);
}
export function rememberWorkspace(
  before: Data,
  after: Data,
  read: () => Data,
  write: (d: Data) => void,
) {
  const changes = effective(makeWorkspaceDelta(before, after, 0, '', {}).changes);
  if (!changes.length) return;
  const text =
    typeof document !== 'undefined' &&
    document.activeElement?.matches(
      'textarea,input[type=text],input:not([type]),[contenteditable=true]',
    );
  const key = text ? changes.map((c) => deltaKey(c)).join('|') : undefined;
  type Command = UndoCommand & { changes: DeltaChange[] };
  const command = (delta: DeltaChange[]): Command => ({
    label: '工作空间编辑',
    mergeKey: key,
    changes: delta,
    undo: () => businessUndo.withoutCapture(() => write(applyUndoDelta(delta, read(), true))),
    redo: () => businessUndo.withoutCapture(() => write(applyUndoDelta(delta, read(), false))),
    merge: (next) => {
      const merged = new Map(delta.map((c) => [deltaKey(c), c]));
      for (const c of (next as Command).changes) {
        const old = merged.get(deltaKey(c));
        merged.set(deltaKey(c), old ? { ...old, after: c.after } : c);
      }
      return command(effective([...merged.values()]));
    },
  });
  businessUndo.push(command(structuredClone(changes)));
}
