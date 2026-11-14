import { test, expect } from 'vitest';
import { emptyStudio, ruleActive, duty, studioWeek, studioSettings } from './studio-daily';
test('weekly rules and temporary expiration do not generate business tasks', () => {
  const r = {
    id: crypto.randomUUID(),
    text: '测试要求',
    enabled: true,
    people: [],
    weekdays: [1, 2, 3, 4, 5],
    from: '2026-11-01',
    to: '2026-11-13',
  };
  expect(ruleActive(r, '2026-11-13')).toBe(true);
  expect(ruleActive(r, '2026-11-14')).toBe(false);
  expect(ruleActive({ ...r, enabled: false }, '2026-11-13')).toBe(false);
  expect(studioWeek('2026-11-15')).toEqual([
    '2026-11-09',
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
    '2026-11-14',
    '2026-11-15',
  ]);
});
test('date override and rest days are explicit; invalid assignments/dates rejected', () => {
  const s = emptyStudio();
  s.weekly[5] = ['a'];
  expect(duty(s, '2026-11-13')).toEqual(['a']);
  s.exceptions = [{ date: '2026-11-13', people: [] }];
  expect(duty(s, '2026-11-13')).toEqual([]);
  expect(
    studioSettings.safeParse({ ...s, exceptions: [{ date: 'bad', people: [] }] }).success,
  ).toBe(false);
});
