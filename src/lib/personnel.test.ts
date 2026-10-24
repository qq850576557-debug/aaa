import { expect, it } from 'vitest';
import { emptyData, newProject, defaultTrades, parseBackup, type Data } from './model';
import { saveDictionary, deleteDictionary, categoryName, tradeNames } from './dictionaries';
import { staffConflicts, staffWork } from './readiness';
import { emptyHistory, recordChanges, restoreBefore, GLOBAL_SCOPE } from './history';
function fixture(): Data {
  const d = emptyData();
  d.projects = [
    { ...newProject(), id: 'a', name: '甲' },
    { ...newProject(), id: 'b', name: '乙' },
  ];
  d.trades = [...defaultTrades('a'), ...defaultTrades('b')];
  d.people = [
    { id: 'w', name: '工人', role: '施工人员', trade: '旧木工', notes: '', active: true },
  ];
  d.trades[0].staffIds = ['w'];
  d.trades[8].staffIds = ['w'];
  d.tasks = [
    {
      id: 'ta',
      projectId: 'a',
      tradeId: d.trades[0].id,
      name: '段甲',
      start: '2026-11-01',
      end: '2026-11-03',
      owner: '',
      status: '未开始',
      notes: '',
    },
    {
      id: 'tb',
      projectId: 'b',
      tradeId: d.trades[8].id,
      name: '段乙',
      start: '2026-11-03',
      end: '2026-11-05',
      owner: '',
      status: '未开始',
      notes: '',
    },
  ];
  return d;
}
it('preserves legacy values without inventing dictionary relationships', () => {
  const d = fixture();
  expect(parseBackup(d)).toEqual(d);
  expect(categoryName(d, d.people![0])).toBe('施工人员');
  expect(tradeNames(d, d.people![0])).toBe('旧木工');
});
it('adds renames deactivates and protects dictionaries with stable IDs, multiple trades and backup compatibility', () => {
  let d = fixture();
  d = saveDictionary(d, { id: 'cat', kind: 'category', label: '合作师傅', active: true, order: 0 });
  d = saveDictionary(d, { id: 'wood', kind: 'trade', label: '木作', active: true, order: 1 });
  d.people![0].categoryId = 'cat';
  d.people![0].tradeIds = ['wood'];
  d = saveDictionary(d, { ...d.dictionaries![1], label: '精细木作', active: false });
  expect(tradeNames(d, d.people![0])).toBe('精细木作');
  expect(() => deleteDictionary(d, 'wood')).toThrow('引用');
  expect(parseBackup(JSON.parse(JSON.stringify(d)))).toEqual(d);
  expect(() =>
    saveDictionary(d, { id: 'copy', kind: 'trade', label: '精细木作', active: true, order: 2 }),
  ).toThrow('同名');
  expect(() => parseBackup({ ...d, dictionaries: [] })).toThrow('引用');
});
it('allows protected deletion of unused options and atomically restores dictionary plus staff links in global history', () => {
  let d = fixture();
  d = saveDictionary(d, { id: 'cat', kind: 'category', label: '原类别', active: true, order: 0 });
  d.people![0].categoryId = 'cat';
  const next = saveDictionary(d, { ...d.dictionaries![0], label: '新类别' });
  const now = Date.now(),
    r = recordChanges(d, next, emptyHistory(), now),
    record = r.history.records.find((r) => r.scope === GLOBAL_SCOPE)!;
  expect(record.changes.some((c) => c.module === '人员字典')).toBe(true);
  expect(restoreBefore(r.data, r.history, record.id, now).dictionaries).toEqual(d.dictionaries);
  const unused = saveDictionary(d, {
    id: 'unused',
    kind: 'trade',
    label: '备用',
    active: true,
    order: 2,
  });
  expect(deleteDictionary(unused, 'unused').dictionaries!.at(-1)?.deleted).toBe(true);
});
it('finds inclusive boundary overlap across projects and derives dates without copying schedules', () => {
  const d = fixture(),
    before = JSON.stringify(d);
  expect(staffConflicts(d)).toHaveLength(1);
  expect(staffConflicts(d)[0].start).toBe('2026-11-03');
  expect(staffConflicts(d)[0].end).toBe('2026-11-03');
  expect(JSON.stringify(d)).toBe(before);
  d.tasks[0].end = '2026-11-02';
  expect(staffConflicts(d)).toEqual([]);
  expect(staffWork(d, 'w')[0].tasks[0].end).toBe('2026-11-02');
});
it('ignores completed tasks/historical projects and same-project overlap, keeps noncontiguous segments independent', () => {
  const d = fixture();
  d.tasks[0].status = '已完成';
  expect(staffConflicts(d)).toEqual([]);
  d.tasks[0].status = '未开始';
  d.projects[1].status = '已完工';
  expect(staffConflicts(d)).toEqual([]);
  d.projects[1].status = '施工中';
  d.tasks.push({ ...d.tasks[0], id: 'ta2', start: '2026-11-09', end: '2026-11-11' });
  expect(staffConflicts(d)).toHaveLength(1);
  d.tasks[1].start = '2026-11-05';
  d.tasks[1].end = '2026-11-07';
  expect(staffConflicts(d)).toEqual([]);
});
it('project version restore recomputes conflicts and assignments without overwriting another project', () => {
  const d = fixture(),
    next = structuredClone(d);
  next.trades[0].staffIds = [];
  const now = Date.now(),
    r = recordChanges(d, next, emptyHistory(), now),
    version = r.history.records.find((r) => r.scope === 'a')!;
  expect(staffConflicts(r.data)).toEqual([]);
  const restored = restoreBefore(r.data, r.history, version.id, now);
  expect(staffConflicts(restored)).toHaveLength(1);
  expect(restored.tasks.find((t) => t.id === 'tb')).toEqual(d.tasks[1]);
});
