import { it, expect } from 'vitest';
import { nextTradeColor } from './trade-colors';
import { emptyData, newProject, defaultTrades, palette } from './model';
it('selects an unused project color first and avoids both adjacent trades when reusing a full palette', () => {
  const d = emptyData(),
    p = newProject();
  d.projects = [p];
  d.trades = defaultTrades(p.id).slice(0, 3);
  expect(nextTradeColor(d, p.id, 1)).toBe(palette[3]);
  d.trades = defaultTrades(p.id);
  const before = structuredClone(d);
  const color = nextTradeColor(d, p.id, 1);
  expect([d.trades[0].color, d.trades[1].color]).not.toContain(color);
  expect(d).toEqual(before);
  expect(nextTradeColor(emptyData(), 'empty', 0)).toBe(palette[0]);
});
