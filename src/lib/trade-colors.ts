import { palette, tradeNames, parseBackup, defaultTrades, type Data, type Trade } from './model';
import { hexToHsva } from '@uiw/color-convert';
const stageAliases: Record<string, string> = {
  拆除阶段: '现场拆改',
  水电阶段: '水电改造',
  木工阶段: '木工吊顶',
  油漆阶段: '墙面油漆',
  墙面油漆: '墙面油漆',
  墙面油漆施工: '墙面油漆',
};
export function defaultTradeColor(name: string) {
  const index = tradeNames.indexOf(
    Object.hasOwn(stageAliases, name.trim()) ? stageAliases[name.trim()] : name.trim(),
  );
  return index < 0 ? undefined : palette[index];
}
export function stageColorKey(name: string) {
  const value = name.normalize('NFKC').trim();
  return Object.hasOwn(stageAliases, value) ? stageAliases[value] : value;
}
/** An explicit shared-color save changes colors only, never dates or staff IDs. */
export function saveSharedTradeColor(data: Data, tradeId: string, color: string): Data {
  const source = data.trades.find((g) => g.id === tradeId);
  if (!source) throw Error('工种已不存在，请重新读取后调整颜色');
  return parseBackup({
    ...data,
    trades: data.trades.map((g) =>
      stageColorKey(g.name) === stageColorKey(source.name) ? { ...g, color } : g,
    ),
  });
}
export function initialStageColor(data: Data, name: string, fallback: string) {
  const same = data.trades.filter((g) => stageColorKey(g.name) === stageColorKey(name));
  const custom = same.find((g) => g.color.toLowerCase() !== g.defaultColor.toLowerCase());
  return (
    custom?.color || (same[0] && resolvedTradeColor(same[0])) || defaultTradeColor(name) || fallback
  );
}
export function newProjectTrades(data: Data, projectId: string) {
  return defaultTrades(projectId).map((g) => ({
    ...g,
    color: initialStageColor(data, g.name, g.color),
  }));
}
/** Stored color is authoritative. Never remap a saved hue by project or stage name. */
export function resolvedTradeColor(trade: Pick<Trade, 'name' | 'color' | 'defaultColor'>) {
  return trade.color;
}
export function tradeTone(color: string, white: number) {
  const rgb = color
    .slice(1)
    .match(/../g)!
    .map((x) => parseInt(x, 16));
  return (
    '#' +
    rgb
      .map((x) =>
        Math.round(x * (1 - white) + 255 * white)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
// Named defaults are stable across projects. Custom/new stages avoid their neighbors.
export function nextTradeColor(data: Data, projectId: string, index: number) {
  const trades = data.trades
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.order - b.order);
  const adjacent = new Set([
    trades[index - 1] && resolvedTradeColor(trades[index - 1]).toLowerCase(),
    trades[index] && resolvedTradeColor(trades[index]).toLowerCase(),
  ]);
  const used = new Set(trades.map((t) => resolvedTradeColor(t).toLowerCase()));
  const unused = palette.filter((c) => !used.has(c));
  const candidates = unused.length ? unused : palette.filter((c) => !adjacent.has(c));
  const hues = [...adjacent].filter((c): c is string => !!c).map((c) => hexToHsva(c).h);
  const score = (color: string) => {
    const h = hexToHsva(color).h;
    return hues.length
      ? Math.min(...hues.map((n) => Math.min(Math.abs(h - n), 360 - Math.abs(h - n))))
      : 0;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0] || palette[0];
}
