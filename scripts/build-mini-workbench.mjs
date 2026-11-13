import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Do not rebuild the released sidecar runtime or the frozen 1.2.2 source ZIP.
const result = await build({
  entryPoints: ['src/lib/mini-workbench.ts'],
  outfile: 'miniprogram/chunmo-photo/lib/shared-workbench.js',
  metafile: true,
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2020',
  minify: true,
  legalComments: 'inline',
});

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = {};
for (const file of Object.keys(result.metafile.inputs).filter((p) => p.startsWith('src/')))
  sources[file] = digest(await readFile(file));
await writeFile(
  'miniprogram/chunmo-photo/lib/shared-workbench.manifest.json',
  JSON.stringify(
    { sources, sha256: digest(await readFile('miniprogram/chunmo-photo/lib/shared-workbench.js')) },
    null,
    2,
  ) + '\n',
);
