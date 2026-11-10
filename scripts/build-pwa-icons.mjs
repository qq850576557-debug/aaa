import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Exact user-supplied square original avoids the old circular cutout's matte rim.
// Only scale/composite backgrounds; never trace or redraw the brand graphic.
const source = 'public/brand/source/chunmo-original.jpg';
const transparentSource = 'public/brand/source/chunmo-original-circle.png';
const original = await readFile(source);
const green = '#9db67f';
const outputs = [
  ['apple-touch-icon-v12.png', 180, 1],
  ['pwa-192-v12.png', 192, 1],
  ['pwa-512-v12.png', 512, 1],
  ['pwa-maskable-v12.png', 512, 0.84],
  ['favicon-32-v12.png', 32, 1],
];
await sharp(transparentSource).resize(64, 64).png().toFile('public/brand/favicon-circle-v12.png');
for (const [name, size, scale] of outputs) {
  const inner = Math.round(size * scale);
  const logo = await sharp(original).resize(inner, inner, { fit: 'contain' }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: green } })
    .composite([{ input: logo, gravity: 'centre' }])
    .removeAlpha()
    .png()
    .toFile(`public/brand/${name}`);
}
await writeFile(
  'public/brand/pwa-icons-v12.json',
  JSON.stringify(
    {
      version: '20261110-v12',
      source,
      sourceSha256: createHash('sha256').update(original).digest('hex'),
      transparentSource,
      transparentSourceSha256: createHash('sha256')
        .update(await readFile(transparentSource))
        .digest('hex'),
      background: green,
      outputs,
    },
    null,
    2,
  ) + '\n',
);
