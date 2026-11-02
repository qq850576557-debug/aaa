import { expect, it } from 'vitest';
import { remainingSchedule, staffWork } from './readiness';
import { emptyData, newProject, defaultTrades } from './model';
it('calculates calendar-day remaining periods including deadlines, overdue and complete history', () => {
  const p = { ...newProject(), end: '2026-10-24' };
  expect(remainingSchedule(p, '2026-10-24')).toBe('今日计划完工');
  expect(remainingSchedule(p, '2026-10-23')).toBe('即将完工 · 剩余 1 天');
  expect(remainingSchedule(p, '2026-10-25')).toBe('已超期 1 天');
  expect(remainingSchedule({ ...p, end: '2027-01-01' }, '2026-12-31')).toContain('1 天');
  expect(remainingSchedule({ ...p, status: '已完工' }, '2026-11-01')).toBe('已完工');
  expect(remainingSchedule({ ...p, end: '' })).toBe('剩余工期未设置');
});
it('derives deduplicated project history and explicit task segments from shared assignments', () => {
  const d = emptyData(),
    p = { ...newProject(), name: '工地' };
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  d.trades[0].staffIds = ['worker'];
  d.trades[1].staffIds = ['worker'];
  d.tasks = [
    {
      id: 't',
      projectId: p.id,
      tradeId: d.trades[0].id,
      name: '第一段',
      start: '2026-11-01',
      end: '2026-11-02',
      owner: '',
      notes: '',
      status: '未开始',
    },
  ];
  const w = staffWork(d, 'worker', '2026-10-24');
  expect(w).toHaveLength(1);
  expect(w[0].tasks.map((t) => t.id)).toEqual(['t']);
  expect(w[0].status).toBe('未进场');
  expect(staffWork(d, 'other')).toEqual([]);
});

import { staffConflicts } from './readiness';
import { fixture } from '../../tests/helpers';
function assignmentFixture() {
  const d = fixture();
  d.people = ['a', 'b'].map((id) => ({
    id,
    name: '同名瓦工',
    trade: '瓦工',
    role: '施工人员' as const,
    active: true,
    notes: '',
  }));
  d.projects = ['p1', 'p2'].map((id) => ({ ...newProject(), id, name: id }));
  d.trades = d.projects.map((p) => ({
    ...defaultTrades(p.id)[0],
    id: 'g' + p.id,
    staffIds: ['a'],
  }));
  d.tasks = d.projects.map((p) => ({
    id: 't' + p.id,
    projectId: p.id,
    tradeId: 'g' + p.id,
    name: '铺砖',
    start: '2026-11-01',
    end: '2026-11-03',
    owner: '',
    notes: '',
    status: '未开始' as const,
  }));
  return d;
}
it('task assignment overrides inherited trade staff, including explicit cancellation and same names', () => {
  const d = assignmentFixture();
  d.tasks[1].staffIds = ['b'];
  expect(staffConflicts(d)).toEqual([]);
  expect(staffWork(d, 'a')[1].tasks).toEqual([]);
  d.tasks[1].staffIds = ['a'];
  expect(staffConflicts(d)[0]).toMatchObject({ person: { id: 'a' }, days: 3 });
  d.tasks[1].staffIds = [];
  expect(staffConflicts(d)).toEqual([]);
});
it('inclusive boundaries, reassignment, completed tasks, paused sites and inactive/deleted workers update without cache', () => {
  const d = assignmentFixture();
  d.tasks[1].start = '2026-11-03';
  expect(staffConflicts(d)[0].days).toBe(1);
  d.tasks[1].start = '2026-11-04';
  d.tasks[1].end = '2026-11-05';
  expect(staffConflicts(d)).toEqual([]);
  d.tasks[1].start = '2026-11-01';
  for (const change of [
    () => (d.people![0].active = false),
    () => {
      d.people![0].active = true;
      d.people![0].deleted = true;
    },
    () => {
      d.people![0].deleted = false;
      d.projects[1].status = '暂停';
    },
    () => {
      d.projects[1].status = '施工中';
      d.tasks[1].status = '已完成';
    },
  ]) {
    change();
    expect(staffConflicts(d)).toEqual([]);
  }
});
it('unknown IDs and ambiguous historical labels are never guessed or merged', () => {
  const d = assignmentFixture();
  d.tasks[1].staffIds = ['missing'];
  const original = structuredClone(d);
  expect(staffConflicts(d)).toEqual([]);
  expect(d).toEqual(original);
});

import { staffAssignmentIssues } from './readiness';
it('lists unresolved historical references and duplicate identities without modifying the data', () => {
  const d = assignmentFixture();
  d.tasks[1].staffIds = ['unknown'];
  const before = structuredClone(d);
  expect(staffAssignmentIssues(d)).toContainEqual(expect.objectContaining({ personId: 'unknown' }));
  expect(d).toEqual(before);
  d.people!.push({ ...d.people![0] });
  expect(staffAssignmentIssues(d)).toContainEqual(
    expect.objectContaining({ personId: 'a', reason: '人员ID重复，身份待确认' }),
  );
  expect(staffConflicts(d)).toEqual([]);
});

it('same-site tasks never conflict and invalid ranges do not inflate overlap', () => {
  const d = assignmentFixture();
  d.tasks[1].projectId = d.projects[0].id;
  d.tasks[1].tradeId = d.trades[0].id;
  expect(staffConflicts(d)).toEqual([]);
  d.tasks[1].projectId = d.projects[1].id;
  d.tasks[1].tradeId = d.trades[1].id;
  d.tasks[1].end = '2026-10-01';
  expect(staffConflicts(d)).toEqual([]);
});
