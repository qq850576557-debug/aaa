import { test, expect } from 'vitest';
import {
  changeRotation,
  effectiveActual,
  rotationBetween,
  rotationPreview,
  RotationConflict,
} from './studio-rotation';
import { studioDay } from './studio-daily';

const people = ['马春旭', '李红伟', '第三位'];
const start = '2026-11-15';
const at = '2026-11-23T00:00:00Z';
const id = () => crypto.randomUUID();
const setup = (interval: 3 | 7 = 7, members = people) =>
  changeRotation(
    undefined,
    { action: 'configure', interval, people: members, start, currentDate: start },
    id(),
    at,
    start,
  );

test.each([
  ['2026-11-21', '马春旭', '2026-11-15', '2026-11-22'],
  ['2026-11-22', '李红伟', '2026-11-22', '2026-11-29'],
  ['2026-11-23', '李红伟', '2026-11-22', '2026-11-29'],
  ['2026-11-29', '第三位', '2026-11-29', '2026-12-06'],
])(
  'automatically rotates on %s without creating completion history',
  (day, person, planned, next) => {
    const r = setup();
    const [now, following, third] = rotationPreview(r, day);
    expect(now).toMatchObject({ person, planned, current: true });
    expect(following.planned).toBe(next);
    expect(third.planned > next).toBe(true);
    expect(r.history).toEqual([]);
    expect(r.currentDate).toBe(start);
  },
);

test('three-day rotation supports one person, many cycles, future dates and year rollover', () => {
  const r = setup(3, ['单人']);
  expect(rotationPreview(r, '2026-11-01')[0]).toMatchObject({ planned: start, current: false });
  expect(rotationPreview(r, '2027-01-02')).toMatchObject([
    { person: '单人', planned: '2027-01-02' },
    { planned: '2027-01-05' },
    { planned: '2027-01-08' },
  ]);
  expect(rotationBetween(r, '2026-12-30', '2027-01-06').map((x) => x.planned)).toEqual([
    '2026-12-30',
    '2027-01-02',
    '2027-01-05',
  ]);
  expect(studioDay(Date.parse('2026-11-21T15:59:59Z'))).toBe('2026-11-21');
  expect(studioDay(Date.parse('2026-11-21T16:00:00Z'))).toBe('2026-11-22');
});

test.each([false, true])(
  'completion records the selected round and only reschedules when selected (%s)',
  (reschedule) => {
    const r = setup();
    const round = { person: '李红伟', planned: '2026-11-22' };
    const date = '2026-11-23';
    const next = changeRotation(
      r,
      { action: 'complete', round, actual: date, reschedule },
      id(),
      at,
      date,
    );
    expect(next.history).toMatchObject([{ ...round, actual: date }]);
    expect(next.currentDate).toBe(reschedule ? '2026-11-30' : '2026-11-29');
    expect(rotationPreview(next, date)[0].person).toBe('第三位');
    expect(() =>
      changeRotation(next, { action: 'complete', round, actual: date, reschedule }, id(), at, date),
    ).toThrow(RotationConflict);
    expect(() =>
      changeRotation(
        r,
        { action: 'complete', round, actual: date, reschedule },
        id(),
        at,
        '2026-11-29',
      ),
    ).toThrow(RotationConflict);
  },
);

test('early completion and corrections keep originals and only move the anchor on request', () => {
  const r = setup(3);
  const actual = '2026-11-14';
  const saved = changeRotation(
    r,
    { action: 'complete', actual, round: { person: people[0], planned: start }, reschedule: true },
    id(),
    at,
    actual,
  );
  expect(saved.currentDate).toBe('2026-11-17');
  const roundId = saved.history[0].id;
  const corrected = changeRotation(
    saved,
    { action: 'correctLast', roundId, actual: '2026-11-16', reschedule: true },
    id(),
    at,
    '2026-11-16',
  );
  expect(corrected.history).toEqual(saved.history);
  expect(corrected.corrections).toHaveLength(1);
  expect(effectiveActual(corrected, saved.history[0])).toBe('2026-11-16');
  expect(corrected.currentDate).toBe('2026-11-19');
  const fixed = changeRotation(
    corrected,
    { action: 'correctLast', roundId, actual, reschedule: false },
    id(),
    at,
    '2026-11-16',
  );
  expect(fixed.currentDate).toBe('2026-11-19');
  expect(fixed.corrections).toHaveLength(2);
  const rescheduledAgain = changeRotation(
    fixed,
    { action: 'correctLast', roundId, actual, reschedule: true },
    id(),
    at,
    '2026-11-16',
  );
  expect(rescheduledAgain.currentDate).toBe('2026-11-17');
  expect(rescheduledAgain.history).toEqual(saved.history);
});

test('reordering keeps the effective current person when still present', () => {
  const day = '2026-11-23';
  const r = setup();
  const edited = changeRotation(
    r,
    {
      action: 'configure',
      interval: 7,
      people: ['第三位', '李红伟', '马春旭'],
      start,
      currentDate: '2026-11-22',
    },
    id(),
    at,
    day,
  );
  expect(rotationPreview(edited, day).map((x) => x.person)).toEqual(['李红伟', '马春旭', '第三位']);
  const removed = changeRotation(
    r,
    {
      action: 'configure',
      interval: 7,
      people: ['第三位', '马春旭'],
      start,
      currentDate: '2026-11-22',
    },
    id(),
    at,
    day,
  );
  expect(rotationPreview(removed, day)[0].person).toBe('第三位');
});
