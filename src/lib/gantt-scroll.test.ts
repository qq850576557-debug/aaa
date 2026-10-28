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
