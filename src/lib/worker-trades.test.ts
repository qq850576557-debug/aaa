import { it, expect } from 'vitest';
import { emptyData, newProject, defaultTrades, parseBackup, type Data } from './model';
import {
  workerTradeChoices,
  workerCatalog,
  saveWorkerTrade,
  removeWorkerTrade,
  reorderWorkerTrades,
  reorderPeople,
} from './worker-trades';
import { personDropTarget } from './person-sort';
import { emptyHistory, recordChanges, restoreBefore, GLOBAL_SCOPE } from './history';
import { mergeWorkspace } from './workspace-merge';

function data(): Data {
  const d = emptyData();
  d.projects = [{ ...newProject(), id: 'site', name: '测试工地' }];
  d.trades = defaultTrades('site');
  d.dictionaries = [
    { id: 'wood-old', kind: 'trade', label: '木工', active: true, order: 0 },
    { id: 'wood-duplicate', kind: 'trade', label: ' 木作工 ', active: true, order: 1 },
    { id: 'wood-stage', kind: 'trade', label: '木工吊顶', active: true, order: 2 },
  ];
  d.people = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    name: '师傅' + id,
    role: '施工人员',
    trade: '',
    tradeIds: id === 'a' ? ['wood-old', 'wood-stage'] : [],
    active: true,
    notes: '原备注',
  }));
  d.trades[0].staffIds = ['a'];
  return d;
}
it('separates worker types from stages, groups aliases once, retains all original IDs and never writes on read', () => {
  const d = data(),
    before = structuredClone(d),
    choices = workerTradeChoices(d);
  expect(choices.map((x) => x.label)).toEqual(
    expect.arrayContaining(['木工', '水电工', '泥工', '瓦工', '安装工']),
  );
  expect(choices.filter((x) => x.label === '木工')).toHaveLength(1);
  expect(choices.some((x) => x.label === '木工吊顶' || x.label === '水电改造')).toBe(false);
  expect(choices.find((x) => x.label === '木工')!.ids).toEqual(
    expect.arrayContaining(['wood-old', 'wood-duplicate']),
  );
  expect(workerTradeChoices(d)).toEqual(choices);
  expect(workerCatalog(d).map((x) => x.id)).toEqual(workerCatalog(d).map((x) => x.id));
  expect(d).toEqual(before);
});
it('renames and deactivates an alias group without changing legacy references, stage records or task dates; defaults do not resurrect', () => {
  const d = data(),
    choice = workerTradeChoices(d).find((x) => x.label === '木工')!;
  const renamed = saveWorkerTrade(d, { label: '精细木作', order: 0, active: true }, choice.id);
  expect(renamed.dictionaries!.find((x) => x.id === 'wood-old')!.label).toBe('精细木作');
  expect(renamed.dictionaries!.find((x) => x.id === 'wood-duplicate')!.label).toBe('精细木作');
  expect(renamed.dictionaries!.find((x) => x.id === 'wood-stage')).toEqual(d.dictionaries![2]);
  expect(workerTradeChoices(renamed).filter((x) => x.label === '精细木作')).toHaveLength(1);
  expect(workerTradeChoices(renamed).some((x) => x.label === '木工')).toBe(false);
  const stopped = removeWorkerTrade(renamed, choice.id);
  expect(stopped.people).toEqual(d.people);
  expect(stopped.trades).toEqual(d.trades);
  expect(stopped.dictionaries!.find((x) => x.id === 'wood-old')).toMatchObject({
    active: false,
    deleted: false,
  });
  expect(parseBackup(JSON.parse(JSON.stringify(stopped)))).toEqual(stopped);
});
it('supports explicit custom worker types, rejects synonyms and known stages, persists order and soft deletion', () => {
  const original = data();
  expect(() => saveWorkerTrade(original, { label: '木作工', active: true, order: 0 })).toThrow(
    '同名或同义',
  );
  expect(() => saveWorkerTrade(original, { label: '油漆阶段', active: true, order: 0 })).toThrow(
    '施工阶段',
  );
  let d = saveWorkerTrade(original, { label: '玻璃安装工', active: true, order: 10 });
  const custom = workerTradeChoices(d).find((x) => x.label === '玻璃安装工')!;
  expect(d.dictionaries!.find((x) => x.id === custom.id)).toMatchObject({ usage: 'worker' });
  d = reorderWorkerTrades(d, custom.id, workerTradeChoices(d)[0].id);
  expect(workerTradeChoices(d)[0].id).toBe(custom.id);
  d = removeWorkerTrade(d, custom.id);
  expect(d.dictionaries!.find((x) => x.id === custom.id)).toMatchObject({
    deleted: true,
    active: false,
  });
  expect(d.people).toEqual(original.people);
  expect(d.trades).toEqual(original.trades);
});
it('persists personnel order in history and restores exact order without changing fields or relationships', () => {
  const d = data(),
    next = reorderPeople(d, 'd', 'b');
  expect(next.people!.map((p) => p.id)).toEqual(['a', 'd', 'b', 'c']);
  for (const p of next.people!) expect(p).toEqual(d.people!.find((x) => x.id === p.id));
  const r = recordChanges(d, next, emptyHistory());
  const event = r.history.records.find((x) => x.scope === GLOBAL_SCOPE)!;
  expect(event.changes.some((x) => x.label === '人员显示顺序')).toBe(true);
  expect(restoreBefore(r.data, r.history, event.id).people).toEqual(d.people);
  expect(next.trades).toEqual(d.trades);
});
it('merges sorting with independent personnel fields but protects competing sorts and retains explicit resolution', () => {
  const base = data(),
    local = reorderPeople(base, 'd', 'a'),
    remote = structuredClone(base);
  remote.people![1].notes = '另一员工的新备注';
  const merged = mergeWorkspace(base, local, remote);
  expect(merged.conflicts).toHaveLength(0);
  expect(merged.data.people!.map((p) => p.id)).toEqual(['d', 'a', 'b', 'c']);
  expect(merged.data.people!.find((p) => p.id === 'b')!.notes).toBe('另一员工的新备注');
  const competing = reorderPeople(base, 'b', 'a'),
    conflict = mergeWorkspace(base, local, competing);
  expect(conflict.conflicts).toHaveLength(1);
  expect(conflict.conflicts[0]).toMatchObject({ collection: 'people', field: 'order' });
  const resolved = mergeWorkspace(base, local, competing, {
    [conflict.conflicts[0].key]: 'remote',
  });
  expect(resolved.conflicts).toHaveLength(0);
  expect(resolved.data.people).toEqual(competing.people);
});
it('hit-tests actual two-dimensional cards and matches before/after lines across rows and gaps', () => {
  const rects = [
    { id: 'a', left: 0, top: 0, right: 100, bottom: 100 },
    { id: 'b', left: 120, top: 0, right: 220, bottom: 100 },
    { id: 'c', left: 0, top: 120, right: 100, bottom: 240 },
    { id: 'd', left: 120, top: 120, right: 220, bottom: 240 },
  ];
  expect(personDropTarget(rects, 125, 160)).toEqual({ target: 'd', edge: 'before', before: 'd' });
  expect(personDropTarget(rects, 210, 160)).toEqual({ target: 'd', edge: 'after', before: null });
  expect(personDropTarget(rects, 110, 130)?.before).toBe('d');
  expect(personDropTarget(rects, 400, 160)).toBeNull();
});
