import { expect, it } from 'vitest';
import {
  assessmentCandidates,
  assessmentCSV,
  assessmentStats,
  assessmentToday,
  dailyAssessments,
  type Assessment,
} from './assessments';
import { defaultTrades, emptyData, newProject } from './model';
it('only real assigned construction personnel are candidates; no artificial saved statistics', () => {
  const d = emptyData(),
    p = { ...newProject(), name: '测试' };
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  d.people = [
    { id: 'worker', name: '王师傅', role: '施工人员', active: true, trade: '', notes: '' },
    { id: 'manager', name: '监理', role: '监理', active: true, trade: '', notes: '' },
  ];
  expect(assessmentCandidates(d, '2026-10-27')).toEqual([]);
  d.trades[0].staffIds = ['worker', 'manager'];
  expect(assessmentCandidates(d, '2026-10-27')).toEqual([
    { date: '2026-10-27', personId: 'worker', projectId: p.id, tradeId: d.trades[0].id },
  ]);
  expect(assessmentStats([])).toEqual([]);
});
it('pending and negative are counted separately; project/person identities do not mix', () => {
  const base = {
    id: 'first',
    date: '2026-10-27',
    tradeId: 'trade-one',
    updatedAt: '2026-10-27T10:00:00Z',
    personId: 'a',
    personName: '王师傅',
    projectId: 'p',
    projectName: '项目',
    attendance: 'yes',
    photo: 'pending',
    cleaning: 'no',
  } as Assessment;
  const rows = [
    base,
    { ...base, id: 'second', date: '2026-10-28', photo: 'yes', cleaning: 'pending' },
    { ...base, personId: 'b', photo: 'no' },
    { ...base, projectId: 'other' },
  ] as Assessment[];
  const stats = assessmentStats(rows);
  expect(stats).toHaveLength(3);
  expect(stats[0].counts.photo).toEqual({ pending: 1, yes: 1, no: 0 });
  expect(stats[0].counts.cleaning).toEqual({ pending: 1, yes: 0, no: 1 });
  expect(stats[0].total).toBe(2);
});
it('CSV preserves Chinese/quotes and neutralizes spreadsheet formulas', () => {
  const row = {
    date: '2026-10-27',
    personName: '=danger',
    projectName: '项目"A',
    tradeName: '水电',
    attendance: 'pending',
    photo: 'no',
    cleaning: 'yes',
    createdName: '监理',
    createdAt: 'server-time',
    updatedName: '监理',
    updatedAt: 'server-time',
  } as Assessment;
  const csv = assessmentCSV([row]);
  expect(csv.startsWith('\ufeff')).toBe(true);
  expect(csv).toContain('"\'=danger"');
  expect(csv).toContain('项目""A');
  expect(csv).toContain('"待记录","未拍照","已打扫"');
});

it('legacy multi-trade days are read-only grouped; conflicting states are pending, not failures', () => {
  const a = {
    id: 'one',
    date: '2026-11-01',
    personId: 'worker',
    projectId: 'project',
    tradeId: 'trade-a',
    personName: '同名师傅',
    projectName: '工地',
    updatedAt: '2026-11-02T01:00:00Z',
    attendance: 'yes',
    photo: 'pending',
    cleaning: 'no',
  } as Assessment;
  const b = {
    ...a,
    id: 'two',
    tradeId: 'trade-b',
    photo: 'yes' as const,
    cleaning: 'pending' as const,
  };
  const rows = [a, b];
  const original = JSON.stringify(rows);
  const grouped = dailyAssessments(rows);
  expect(grouped).toHaveLength(1);
  expect(grouped[0]).toMatchObject({
    attendance: 'yes',
    photo: 'yes',
    cleaning: 'no',
    differences: [],
  });
  expect(assessmentStats(rows)[0].total).toBe(1);
  const conflict = { ...b, id: 'three', tradeId: 'trade-c', photo: 'no' as const };
  expect(dailyAssessments([...rows, conflict])[0]).toMatchObject({
    photo: 'pending',
    differences: ['photo'],
  });
  expect(assessmentStats([...rows, conflict])[0].counts.photo).toEqual({
    yes: 0,
    no: 0,
    pending: 1,
  });
  expect(
    assessmentStats([...rows, { ...a, id: 'other-person', personId: 'other-worker' }]),
  ).toHaveLength(2);
  expect(JSON.stringify(rows)).toBe(original);
});
it('assessment business day is explicitly Asia/Shanghai across UTC midnight boundaries', () => {
  expect(assessmentToday(new Date('2026-11-03T16:05:00Z'))).toBe('2026-11-04');
  expect(assessmentToday(new Date('2026-11-03T15:55:00Z'))).toBe('2026-11-03');
});
