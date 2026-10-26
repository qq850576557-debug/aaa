import { it, expect } from 'vitest';
import { timelineRange, timelineWindow } from './timeline';
import { scheduleForecast } from './readiness';
import { emptyData, newProject, defaultTrades } from './model';
it('extends five years including today outside old plans, preserving leap dates', () => {
  const d = emptyData(),
    p = { ...newProject(), start: '2025-12-28', end: '2026-01-01' };
  d.projects = [p];
  expect(timelineRange(d, p, '2028-02-29')).toEqual(['2025-12-28', '2033-02-28']);
  expect(
    timelineWindow(100000, 1000, 3000).last - timelineWindow(100000, 1000, 3000).first,
  ).toBeLessThan(30);
});
it('forecasts from task extrema without declaring early completion and has no fabricated empty dates', () => {
  const d = emptyData(),
    p = { ...newProject(), end: '2027-01-05' };
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  expect(scheduleForecast(d, p)).toMatchObject({
    start: null,
    end: null,
    delta: null,
    label: '待排期',
  });
  d.tasks = [
    {
      id: 't',
      projectId: p.id,
      tradeId: d.trades[0].id,
      name: '施工',
      start: '2026-12-30',
      end: '2027-01-03',
      owner: '',
      notes: '',
      status: '未开始',
    },
  ];
  expect(scheduleForecast(d, p)).toMatchObject({ delta: -2, actual: false });
  expect(scheduleForecast(d, p).label).toContain('预计提前 2 天');
  d.tasks[0].end = '2027-01-08';
  expect(scheduleForecast(d, p).label).toContain('预计延期 3 天');
  expect(
    scheduleForecast(d, {
      ...p,
      status: '已完工',
      actualStart: '2026-12-30',
      actualEnd: '2027-01-06',
    }).label,
  ).toContain('实际延期 1 天');
});
