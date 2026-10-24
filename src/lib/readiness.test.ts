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
