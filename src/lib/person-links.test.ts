import { test, expect } from 'vitest';
import { primaryPerson, duplicatePeople, linkedDailyView } from './person-links';
import { emptyData, type Person } from './model';
import type { Assessment } from './assessments';
const person = (id: string): Person => ({
  id,
  name: '同名师傅',
  trade: '瓦工',
  role: '施工人员',
  active: true,
  notes: '',
});
test('identity requires explicit mapping; cycles and unresolved targets never collapse different people', () => {
  const a = person('a'),
    b = person('b');
  expect(duplicatePeople([a, b], a)).toHaveLength(1);
  expect(primaryPerson([a, b], 'b')).toBe('b');
  b.identityLink = { personId: 'a', reason: '人工确认' };
  expect(primaryPerson([a, b], 'b')).toBe('a');
  a.identityLink = { personId: 'b', reason: '错误循环' };
  expect(primaryPerson([a, b], 'a')).toBe('a');
});
test('confirmed aliases count one day without overwriting original identities or conflicting states', () => {
  const a = person('a'),
    b = { ...person('b'), identityLink: { personId: 'a', reason: '人工确认' } };
  const record = (personId: string, attendance: 'yes' | 'no'): Assessment => ({
    id: personId,
    personId,
    date: '2026-11-04',
    projectId: 'p',
    tradeId: 'daily',
    personName: '旧名称',
    projectName: '工地',
    tradeName: '每日',
    version: 1,
    attendance,
    photo: 'pending',
    cleaning: 'pending',
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
    createdBy: 'x',
    createdName: '记录人',
    updatedBy: 'x',
    updatedName: '记录人',
  });
  const records = [record('a', 'yes'), record('b', 'no')];
  const rows = linkedDailyView(records, { ...emptyData(), people: [a, b] });
  expect(rows).toHaveLength(1);
  expect(rows[0].attendance).toBe('pending');
  expect(rows[0].sources.map((r) => r.personId)).toEqual(['a', 'b']);
  expect(records[1].personId).toBe('b');
  expect(
    linkedDailyView([{ ...records[0], withdrawn: true }], { ...emptyData(), people: [a, b] }),
  ).toHaveLength(0);
});
