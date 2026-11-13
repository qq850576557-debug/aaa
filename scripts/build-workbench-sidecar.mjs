import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir = 'dist-workbench';
await mkdir(dir, { recursive: true });
await build({
  entryPoints: ['server/miniprogram-sidecar-main.ts'],
  outfile: dir + '/sidecar.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  legalComments: 'linked',
});
const files = {};
for (const name of ['sidecar.cjs', 'sidecar.cjs.LEGAL.txt']) {
  const b = await readFile(dir + '/' + name);
  files[name] = { bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
}
await writeFile(
  dir + '/manifest.json',
  JSON.stringify(
    { candidate: true, flag: 'CHUNMO_MINI_WORKBENCH_ENABLED=1', node: '>=22.12', files },
    null,
    2,
  ) + '\n',
);
console.log('Candidate only; no install/deploy; frozen photo runtime unchanged.');
console.log(JSON.stringify(files));
