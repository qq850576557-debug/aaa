import { palette, type Data } from './model';
// Color belongs to a trade, never to individual segments. Existing colors stay intact.
export function nextTradeColor(data: Data, projectId: string, index: number) {
  const trades = data.trades
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.order - b.order);
  const adjacent = new Set([
    trades[index - 1]?.color.toLowerCase(),
    trades[index]?.color.toLowerCase(),
  ]);
  const used = new Set(trades.map((t) => t.color.toLowerCase()));
  return (
    palette.find((c) => !used.has(c) && !adjacent.has(c)) ??
    palette.find((c) => !adjacent.has(c)) ??
    palette[0]
  );
}
