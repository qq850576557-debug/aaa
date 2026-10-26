import { expect, it } from 'vitest';
import { ganttGroups, resizeGanttGroup } from './gantt-groups';
import { proposeTaskChanges } from './scheduling';
import { emptyData, newProject, defaultTrades, type Task } from './model';
function fixture() {
  const d = emptyData(),
    p = newProject();
  p.name = '测试工地';
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  const task = (id: string, start: string, end: string, order = 0): Task => ({
    id,
    projectId: p.id,
    tradeId: d.trades[order].id,
    name: id,
    start,
    end,
    status: '未开始',
    owner: '陈师傅',
    notes: '备注' + id,
  });
  return { d, p, task };
}
it('projects touching/overlapping trade intervals transitively without altering raw IDs or metadata', () => {
  const { d, task } = fixture();
  d.tasks = [
    task('a', '2026-12-28', '2027-01-01'),
    task('b', '2026-12-30', '2027-01-04'),
    task('c', '2027-01-05', '2027-01-06'),
    task('gap', '2027-01-08', '2027-01-09'),
    task('other-trade', '2027-01-01', '2027-01-03', 1),
  ];
  const before = structuredClone(d);
  const groups = ganttGroups(d.tasks);
  const g = groups.find((g) => g.id === 'a')!;
  expect(g.members.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  expect([g.start, g.end]).toEqual(['2026-12-28', '2027-01-06']);
  expect(groups).toHaveLength(3);
  expect(d).toEqual(before);
  const moved = resizeGanttGroup(g, { ...g, start: '2026-12-26', end: '2027-01-04' }, 'move');
  expect(moved[1]).toEqual({ ...d.tasks[1], start: '2026-12-28', end: '2027-01-02' });
  const plan = proposeTaskChanges(d, moved);
  expect(plan.current.tasks).toHaveLength(5);
  expect(plan.current.tasks.map((t) => t.notes)).toEqual(d.tasks.map((t) => t.notes));
});
it('merged resize clamps internal records to the envelope without deleting one-day or nested records', () => {
  const { task } = fixture();
  const raw = [task('a', '2026-10-22', '2026-10-28'), task('b', '2026-10-24', '2026-10-26')];
  const g = ganttGroups(raw)[0];
  expect(
    resizeGanttGroup(g, { ...g, end: '2026-10-23' }, 'end').map((t) => [t.start, t.end]),
  ).toEqual([
    ['2026-10-22', '2026-10-23'],
    ['2026-10-23', '2026-10-23'],
  ]);
  expect(
    resizeGanttGroup(g, { ...g, start: '2026-10-27' }, 'start').map((t) => [t.start, t.end]),
  ).toEqual([
    ['2026-10-27', '2026-10-28'],
    ['2026-10-27', '2026-10-27'],
  ]);
});
for (const mode of ['move', 'end'] as const)
  it(`advance ${mode} preserves downstream durations/gaps, originals and project isolation`, () => {
    const { d, p, task } = fixture();
    const a = task('a', '2026-12-28', '2027-01-03'),
      b = task('b', '2027-01-06', '2027-01-08', 1),
      c = task('c', '2027-01-11', '2027-01-15', 2),
      parallel = task('parallel', '2027-01-01', '2027-01-04', 3),
      done = { ...task('done', '2027-01-16', '2027-01-18', 4), status: '已完成' as const };
    const other = { ...p, id: 'other' };
    d.projects.push(other);
    const foreign = {
      ...task('foreign', '2027-01-09', '2027-01-10', 1),
      projectId: other.id,
      tradeId: 'foreign-trade',
    };
    d.trades.push({ ...d.trades[1], id: 'foreign-trade', projectId: other.id });
    d.tasks = [a, b, c, parallel, done, foreign];
    const before = structuredClone(d);
    const plan = proposeTaskChanges(d, [
      { ...a, start: mode === 'move' ? '2026-12-26' : a.start, end: '2027-01-01' },
    ]);
    expect(plan.advance).toBe(true);
    expect(plan.affected.map((x) => x.before.id)).toEqual(['b', 'c']);
    expect(plan.shifted.tasks[1]).toEqual({ ...b, start: '2027-01-04', end: '2027-01-06' });
    expect(plan.shifted.tasks[2]).toEqual({ ...c, start: '2027-01-09', end: '2027-01-13' });
    expect(plan.current.tasks[1]).toEqual(b);
    expect(d).toEqual(before);
    expect(plan.shifted.tasks.slice(3)).toEqual(d.tasks.slice(3));
  });
it('explicit downstream chain advances once even within one trade; backward extension still proposes postponement', () => {
  const { d, task } = fixture();
  const a = task('a', '2026-10-22', '2026-10-25'),
    b = { ...task('b', '2026-10-28', '2026-10-29', 1), dependsOn: ['a'] },
    c = { ...task('c', '2026-11-02', '2026-11-03', 1), dependsOn: ['b'] };
  d.tasks = [a, b, c];
  const plan = proposeTaskChanges(d, [{ ...a, end: '2026-10-23' }]);
  expect(plan.affected).toHaveLength(2);
  expect(plan.shifted.tasks[2].start).toBe('2026-10-31');
  const later = proposeTaskChanges(d, [{ ...a, end: '2026-11-02' }]);
  expect(later.advance).toBe(false);
  expect(later.affected).toHaveLength(2);
  expect(later.shifted.tasks[1].start).toBe('2026-11-03');
});
