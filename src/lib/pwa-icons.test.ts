import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
it.each([
  ['apple-touch-icon-v12.png', 180],
  ['pwa-192-v12.png', 192],
  ['pwa-512-v12.png', 512],
  ['pwa-maskable-v12.png', 512],
] as const)('%s is full-bleed opaque brand green with no white perimeter', async (name, size) => {
  const { data, info } = await sharp(`public/brand/${name}`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([size, size]);
  let transparent = 0,
    badEdge = 0,
    whiteRadius = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      if (data[offset + 3] !== 255) transparent++;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1)
        // The untouched original contains +/-2 JPEG background variation, never white.
        if (
          Math.abs(data[offset] - 157) > 3 ||
          Math.abs(data[offset + 1] - 182) > 3 ||
          Math.abs(data[offset + 2] - 127) > 3
        )
          badEdge++;
      if (
        name.includes('maskable') &&
        data[offset] > 225 &&
        data[offset + 1] > 225 &&
        data[offset + 2] > 225
      )
        whiteRadius = Math.max(whiteRadius, Math.hypot(x - size / 2, y - size / 2));
    }
  expect(transparent).toBe(0);
  expect(badEdge).toBe(0);
  expect(whiteRadius).toBeLessThan(size * 0.4);
});
it('icon derivation uses exact original brand artwork without rewriting either brand source', async () => {
  const info = JSON.parse(await readFile('public/brand/pwa-icons-v12.json', 'utf8'));
  expect(
    createHash('sha256')
      .update(await readFile(info.source))
      .digest('hex'),
  ).toBe(info.sourceSha256);
  expect(
    createHash('sha256')
      .update(await readFile(info.transparentSource))
      .digest('hex'),
  ).toBe(info.transparentSourceSha256);
  expect((await sharp('public/brand/source/chunmo-original.jpg').metadata()).width).toBe(1181);
});
