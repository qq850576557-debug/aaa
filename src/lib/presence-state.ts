export type PresenceStatus = 'active' | 'busy' | 'offline';
export const IDLE_MS = 5 * 60_000;
export const PRESENCE_TIMEOUT = 3 * 60_000;
export const presenceLabel = (status: PresenceStatus) =>
  ({ active: '在线', busy: '忙碌', offline: '离线' })[status];
export type PresenceLease = {
  expired?: boolean;
  heartbeatAt: number;
  activeUntil: number;
  status: PresenceStatus;
};
export function leaseStatus(lease: PresenceLease, now = Date.now()): PresenceStatus {
  if (lease.expired || now - lease.heartbeatAt > PRESENCE_TIMEOUT) return 'offline';
  return lease.status === 'active' && now < lease.activeUntil ? 'active' : 'busy';
}
export function aggregatePresence(leases: PresenceLease[], now = Date.now()): PresenceStatus {
  const states = leases.map((x) => leaseStatus(x, now));
  return states.includes('active') ? 'active' : states.includes('busy') ? 'busy' : 'offline';
}
export const browserPresence = (
  visible: boolean,
  focused: boolean,
  lastActivity: number,
  now = Date.now(),
): PresenceStatus => (visible && focused && now - lastActivity < IDLE_MS ? 'active' : 'busy');
