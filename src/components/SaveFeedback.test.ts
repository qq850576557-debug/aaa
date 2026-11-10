import { expect, it } from 'vitest';
import { confirmedTime } from './SaveFeedback';
it('server Date header and ISO acknowledgements compare chronologically instead of retaining an older date string', () => {
  const old = confirmedTime('Tue Nov 10 2026 07:56:50 GMT+0000 (Coordinated Universal Time)');
  const next = confirmedTime('2026-11-10T07:56:51.537Z');
  expect(old).toBe('2026-11-10T07:56:50.000Z');
  expect(next > old).toBe(true);
  expect(confirmedTime('invalid server date')).toBe('');
  expect(confirmedTime(null)).toBe('');
});
