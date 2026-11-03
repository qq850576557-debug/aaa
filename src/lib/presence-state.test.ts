import { it, expect } from 'vitest';
import {
  browserPresence,
  aggregatePresence,
  leaseStatus,
  IDLE_MS,
  PRESENCE_TIMEOUT,
} from './presence-state';
it('foreground + focus + interaction are all required; five-minute boundary is busy', () => {
  expect(browserPresence(true, true, 100, 101)).toBe('active');
  expect(browserPresence(false, true, 100, 101)).toBe('busy');
  expect(browserPresence(true, false, 100, 101)).toBe('busy');
  expect(browserPresence(true, true, 100, 100 + IDLE_MS)).toBe('busy');
  expect(browserPresence(true, true, 100 + IDLE_MS, 101 + IDLE_MS)).toBe('active');
});
it('another active device wins over blurred tabs, but expired heartbeats cannot keep an account online', () => {
  const busy = { heartbeatAt: 100, status: 'busy' as const, activeUntil: 0 },
    active = { heartbeatAt: 100, status: 'active' as const, activeUntil: 100 + IDLE_MS };
  expect(aggregatePresence([busy, active], 101)).toBe('active');
  expect(aggregatePresence([busy], 101)).toBe('busy');
  expect(aggregatePresence([busy, active], 101 + PRESENCE_TIMEOUT)).toBe('offline');
  expect(leaseStatus({ ...active, heartbeatAt: IDLE_MS }, IDLE_MS + 101)).toBe('busy');
});
