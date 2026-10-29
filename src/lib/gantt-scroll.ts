/** Pixels/second; bounded speed with gentle acceleration while holding near an edge. */
export function edgeScrollSpeed(
  x: number,
  left: number,
  right: number,
  heldMs: number,
  velocity = 0,
) {
  const zone = Math.min(56, Math.max(24, (right - left) / 4));
  const direction = x < left + zone ? -1 : x > right - zone ? 1 : 0;
  if (!direction) return 0;
  const proximity = Math.min(
    1,
    Math.max(0, direction < 0 ? (left + zone - x) / zone : (x - right + zone) / zone),
  );
  return (
    direction *
    (70 + 470 * proximity * proximity) *
    (0.65 + 0.35 * Math.min(1, heldMs / 1000)) *
    (1 + Math.min(0.2, Math.abs(velocity) / 4000))
  );
}

/** Wheel units become a bounded pixel movement; diagonal trackpads use one dominant axis. */
export function timelineWheelDelta(x: number, y: number, mode: number, width: number) {
  if (![x, y, width].every(Number.isFinite) || width <= 0) return 0;
  const delta = Math.abs(x) > Math.abs(y) ? x : y;
  const pixels = delta * (mode === 1 ? 20 : mode === 2 ? width : 1);
  const limit = Math.min(280, width * 0.8);
  return Math.max(-limit, Math.min(limit, pixels));
}
