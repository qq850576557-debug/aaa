import { test, expect } from 'vitest';
import { changeRotation, rotationPreview } from './studio-rotation';
const id = () => crypto.randomUUID();
const at = '2026-11-20T00:00:00Z';
function setup(interval: 3 | 7 = 3) {
  return changeRotation(
    undefined,
    {
      action: 'configure',
      interval,
      people: ['A', 'B', 'C'],
      start: '2026-11-16',
      currentDate: '2026-11-16',
    },
    id(),
    at,
  );
}
test('3/7 day cycles and early/late completion use actual date without rewriting history', () => {
  for (const interval of [3, 7] as const) {
    const r = setup(interval);
    expect(rotationPreview(r, 4).map((x) => x.person)).toEqual(['A', 'B', 'C', 'A']);
    const early = changeRotation(r, { action: 'complete', actual: '2026-11-15' }, id(), at);
    expect(early.currentDate).toBe(interval === 3 ? '2026-11-18' : '2026-11-22');
    expect(early.history[0].planned).toBe('2026-11-16');
    const late = changeRotation(r, { action: 'complete', actual: '2026-11-17' }, id(), at);
    expect(late.currentDate).toBe(interval === 3 ? '2026-11-20' : '2026-11-24');
    const switched = changeRotation(
      early,
      {
        action: 'configure',
        interval: 7,
        people: ['C', 'B', 'A'],
        start: r.start,
        currentDate: early.currentDate,
      },
      id(),
      at,
    );
    expect(switched.history).toEqual(early.history);
    expect(rotationPreview(switched, 1)[0].person).toBe('B');
    const corrected = changeRotation(
      early,
      { action: 'correctLast', actual: '2026-11-17' },
      id(),
      at,
    );
    expect(corrected.history).toEqual(early.history);
    expect(corrected.corrections).toHaveLength(1);
  }
});
test('cross-month schedules and removed current employee remain deterministic', () => {
  const r = setup();
  const moved = changeRotation(
    r,
    {
      action: 'configure',
      interval: 3,
      people: ['C', 'B'],
      start: '2026-11-29',
      currentDate: '2026-11-29',
    },
    id(),
    at,
  );
  expect(rotationPreview(moved, 2)).toMatchObject([
    { person: 'C', planned: '2026-11-29' },
    { person: 'B', planned: '2026-12-02' },
  ]);
});
