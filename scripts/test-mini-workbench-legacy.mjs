// Test against the actual source revision observed on Aliyun, in a new cache
// folder and dedicated localhost _test databases. Never checks out the repo.
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const legacy = '2756068e6ce7f6f39a90c75610d24e9479b13f0d';
await mkdir('node_modules/.cache', { recursive: true });
const lab = await mkdtemp(resolve('node_modules/.cache/chunmo-legacy-'));
try {
  const archive = execFileSync('git', ['archive', '--format=tar', legacy, 'server', 'src/lib'], {
    maxBuffer: 32 * 1024 ** 2,
  });
  execFileSync('tar', ['-xf', '-', '-C', lab], { input: archive });
  const entry = join(lab, 'entry.ts');
  await writeFile(
    entry,
    "export { createApp } from './server/app'; export { pool, privatePool } from './server/db';\n",
  );
  const bundle = join(lab, 'legacy.mjs');
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const result = spawnSync(
    process.execPath,
    [
      '--env-file=.env.test.local',
      '--import',
      'tsx',
      '--test',
      '--test-isolation=none',
      'server/mini-workbench.integration.test.ts',
    ],
    { stdio: 'inherit', env: { ...process.env, CHUNMO_LEGACY_APP_BUNDLE: bundle } },
  );
  if (result.error || result.status !== 0)
    throw Error('Legacy workbench API compatibility test failed');
  console.log(
    'PASS actual legacy source ' + legacy + ' + isolated sidecar; production not contacted',
  );
} finally {
  await rm(lab, { recursive: true, force: true });
}
