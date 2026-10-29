import { hexToHsva, hsvaToHex } from '@uiw/color-convert';
export const projectHues = [145, 212, 31, 272, 180, 335, 72, 240, 8];
export type ProjectHues = Record<string, number>;
export function allocateProjectHues(
  projects: { id: string }[],
  previous: ProjectHues,
): ProjectHues {
  const next: ProjectHues = Object.assign(Object.create(null), previous);
  for (let i = 0; i < projects.length; i++) {
    const id = projects[i].id;
    if (Number.isFinite(next[id])) continue;
    const neighbors = [next[projects[i - 1]?.id], next[projects[i + 1]?.id]].filter(
      Number.isFinite,
    );
    const score = (h: number) => {
      const used = Object.values(next).filter((x) => x === h).length;
      const tooClose = neighbors.filter(
        (n) => Math.min(Math.abs(h - n), 360 - Math.abs(h - n)) < 45,
      ).length;
      return used * 10 + tooClose * 100;
    };
    next[id] = [...projectHues].sort((a, b) => score(a) - score(b))[0];
  }
  return next;
}
export function projectTheme(hue = projectHues[0]) {
  const hex = (s: number, v: number) => hsvaToHex({ h: hue, s, v, a: 1 });
  return {
    hue,
    base: hex(43, 63),
    ink: hex(47, 36),
    border: hex(18, 79),
    surface: hex(7, 97),
    tag: hex(17, 91),
  };
}
export function projectTradeColor(hue: number, raw: string) {
  const color = hexToHsva(raw);
  return hsvaToHex({
    ...color,
    h: hue,
    s: Math.max(24, Math.min(58, color.s)),
    v: Math.max(42, Math.min(78, color.v)),
    a: 1,
  });
}
export function readProjectHues(raw: string | null): ProjectHues {
  try {
    const value: unknown = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 5000)
        .filter(
          ([key, h]) =>
            key.length <= 100 && typeof h === 'number' && Number.isFinite(h) && h >= 0 && h < 360,
        ),
    );
  } catch {
    return {};
  }
}
