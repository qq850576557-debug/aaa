import { describe, it, expect } from 'vitest';
import { hexToHsva } from '@uiw/color-convert';
import { allocateProjectHues, projectTheme, readProjectHues } from './project-themes';
describe('presentation-only project palettes', () => {
  it('allocates distinct initial themes and keeps IDs stable on reorder/add/remove/history reads', () => {
    const projects = Array.from({ length: 6 }, (_, i) => ({ id: 'site-' + i }));
    const original = structuredClone(projects),
      hues = allocateProjectHues(projects, {});
    expect(new Set(Object.values(hues)).size).toBe(6);
    const changed = allocateProjectHues([...projects].reverse().concat({ id: 'new-site' }), hues);
    projects.forEach((p) => expect(changed[p.id]).toBe(hues[p.id]));
    const reduced = allocateProjectHues(projects.slice(2), changed);
    expect(reduced['site-0']).toBe(hues['site-0']);
    expect(readProjectHues(JSON.stringify(reduced))).toEqual(reduced);
    expect(projects).toEqual(original);
  });
  it('uses a project hue only for project surfaces; trade colors remain independent', () => {
    const raw = ['#244e42', '#8d779f', '#b6a074'],
      copy = [...raw];
    for (const hue of [145, 212, 31, 272]) {
      const theme = projectTheme(hue);
      const rgbHue = (hex: string) => hexToHsva(hex).h;
      for (const c of [theme.base, theme.ink, theme.tag])
        expect(Math.abs(rgbHue(c) - hue)).toBeLessThan(3);
    }
    expect(raw).toEqual(copy);
  });
  it('rejects invalid color preferences without touching records or relying on object prototype keys', () => {
    expect(readProjectHues('{"a":null,"b":361,"c":"red","d":212}')).toEqual({ d: 212 });
    expect(readProjectHues('[]')).toEqual({});
    expect(readProjectHues('invalid')).toEqual({});
    expect(Number.isFinite(allocateProjectHues([{ id: '__proto__' }], {})['__proto__'])).toBe(true);
  });
});
