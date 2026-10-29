import { it, expect } from 'vitest';
import { edgeScrollSpeed } from './gantt-scroll';
it('edge scrolling has correct direction, stops in center, accelerates and stays bounded', () => {
  expect(edgeScrollSpeed(500, 200, 1000, 5000)).toBe(0);
  expect(edgeScrollSpeed(205, 200, 1000, 1000)).toBeLessThan(0);
  expect(edgeScrollSpeed(995, 200, 1000, 1000)).toBeGreaterThan(
    edgeScrollSpeed(950, 200, 1000, 1000),
  );
  expect(edgeScrollSpeed(995, 200, 1000, 1000)).toBeGreaterThan(edgeScrollSpeed(995, 200, 1000, 0));
  expect(edgeScrollSpeed(5000, 200, 1000, 100000, 100000)).toBeLessThanOrEqual(648);
});

it('wheel pixel/line/page input has consistent direction, bounded speed and no diagonal doubling', async () => {
  const { timelineWheelDelta } = await import('./gantt-scroll');
  expect(timelineWheelDelta(0, 100, 0, 900)).toBe(100);
  expect(timelineWheelDelta(0, -100, 0, 900)).toBe(-100);
  expect(timelineWheelDelta(40, 12, 0, 900)).toBe(40);
  expect(timelineWheelDelta(3, 12, 0, 900)).toBe(12);
  expect(timelineWheelDelta(0, 3, 1, 900)).toBe(60);
  expect(timelineWheelDelta(0, 1, 2, 900)).toBe(280);
  expect(timelineWheelDelta(0, 0.4, 0, 900)).toBe(0.4);
  expect(timelineWheelDelta(0, 100000, 0, 300)).toBe(240);
  expect(timelineWheelDelta(0, NaN, 0, 900)).toBe(0);
  expect(timelineWheelDelta(0, 20, 0, 0)).toBe(0);
});
