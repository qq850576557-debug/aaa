import { it, expect } from 'vitest';
import {
  nextTradeColor,
  resolvedTradeColor,
  defaultTradeColor,
  saveSharedTradeColor,
  newProjectTrades,
} from './trade-colors';
import { hexToHsva } from '@uiw/color-convert';
import { emptyData, newProject, defaultTrades, palette } from './model';
it('selects an unused project color first and avoids both adjacent trades when reusing a full palette', () => {
  const d = emptyData(),
    p = newProject();
  d.projects = [p];
  d.trades = defaultTrades(p.id).slice(0, 3);
  expect(palette.slice(3)).toContain(nextTradeColor(d, p.id, 1));
  d.trades = defaultTrades(p.id);
  const before = structuredClone(d);
  const color = nextTradeColor(d, p.id, 1);
  expect([d.trades[0].color, d.trades[1].color]).not.toContain(color);
  expect(d).toEqual(before);
  expect(nextTradeColor(emptyData(), 'empty', 0)).toBe(palette[0]);
});
it('distinguishes nearly equal hues, not just matching hex strings, and keeps all custom colors exact', () => {
  const d = emptyData();
  d.trades = defaultTrades('site').slice(0, 2);
  d.trades[0].color = '#7b8b47';
  d.trades[1].color = '#c38b35';
  const selected = nextTradeColor(d, 'site', 1),
    hue = hexToHsva(selected).h;
  for (const g of d.trades) {
    const other = hexToHsva(g.color).h;
    expect(Math.min(Math.abs(hue - other), 360 - Math.abs(hue - other))).toBeGreaterThan(100);
  }
  const legacy = { name: '水电改造', color: '#648b9c', defaultColor: '#648b9c' };
  expect(resolvedTradeColor(legacy)).toBe('#648b9c');
  expect(defaultTradeColor('水电改造')).toBe(palette[1]);
  for (const color of ['#dd4422', '#012345', '#ffffff', '#000000', '#648b9c']) {
    expect(resolvedTradeColor({ ...legacy, color, defaultColor: '#8c9a86' })).toBe(color);
  }
  expect(legacy.color).toBe('#648b9c');
});
it('explicit shared colors and future projects agree, while dates, people and other stage colors remain unchanged', () => {
  const d = emptyData();
  d.projects = [
    { ...newProject(), id: 'a', name: '甲' },
    { ...newProject(), id: 'b', name: '乙' },
  ];
  d.trades = [...defaultTrades('a'), ...defaultTrades('b')];
  d.trades[9].color = '#814ac2';
  const before = structuredClone(d),
    next = saveSharedTradeColor(d, d.trades[1].id, '#d65d42');
  expect(next.trades.filter((g) => g.name === '水电改造').map((g) => g.color)).toEqual([
    '#d65d42',
    '#d65d42',
  ]);
  expect(newProjectTrades(next, 'new-site')[1].color).toBe('#d65d42');
  expect(next.projects).toEqual(before.projects);
  expect(next.tasks).toEqual(before.tasks);
  for (const g of next.trades.filter((g) => g.name !== '水电改造'))
    expect(g).toEqual(before.trades.find((x) => x.id === g.id));
  expect(d).toEqual(before);
});
it('never treats masonry as demolition when sharing a stage color', () => {
  const d = emptyData();
  d.projects = [{ ...newProject(), id: 'site', name: '测试工地' }];
  d.trades = defaultTrades('site');
  d.trades.push({ ...d.trades[0], id: 'masonry', name: '砌墙阶段' });
  const next = saveSharedTradeColor(d, d.trades[0].id, '#d65d42');
  expect(next.trades.find((g) => g.id === 'masonry')).toEqual(d.trades.at(-1));
});
