export type SortRect = { id: string; left: number; top: number; right: number; bottom: number };
/** Hit-test the actual wrapping grid, not an assumed row height or column count. */
export function personDropTarget(rects: SortRect[], x: number, y: number) {
  if (!rects.length) return null;
  if (
    x < Math.min(...rects.map((r) => r.left)) - 12 ||
    x > Math.max(...rects.map((r) => r.right)) + 12 ||
    y < Math.min(...rects.map((r) => r.top)) - 12 ||
    y > Math.max(...rects.map((r) => r.bottom)) + 12
  )
    return null;
  const distance = (r: SortRect) =>
    Math.max(r.left - x, 0, x - r.right) ** 2 + Math.max(r.top - y, 0, y - r.bottom) ** 2;
  const closest = [...rects].sort((a, b) => distance(a) - distance(b))[0];
  const vertical = rects.every((r) => Math.abs(r.left - rects[0].left) < 4);
  const after = vertical
    ? y >= (closest.top + closest.bottom) / 2
    : x >= (closest.left + closest.right) / 2;
  const index = rects.indexOf(closest);
  return {
    target: closest.id,
    edge: after ? ('after' as const) : ('before' as const),
    before: after ? (rects[index + 1]?.id ?? null) : closest.id,
    ...(vertical ? { vertical: true } : {}),
  };
}
