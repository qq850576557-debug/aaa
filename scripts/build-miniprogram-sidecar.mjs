import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = 'deploy/miniprogram/runtime.cjs';
await build({
  entryPoints: ['server/miniprogram-sidecar-main.ts'],
  outfile: file,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  legalComments: 'linked',
  sourcemap: false,
});
const names = [file, file + '.LEGAL.txt'];
const files = {};
for (const name of names) {
  const bytes = await readFile(name);
  files[name.split('/').pop()] = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
await writeFile(
  'deploy/miniprogram/runtime-manifest.json',
  JSON.stringify(
    {
      name: 'chunmo-mini-photo',
      protocol: 1,
      node: '>=22.12',
      appId: 'wxb48a7abb3858a252',
      files,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ bundled: true, externalNpmDependencies: 0, files }, null, 2));
