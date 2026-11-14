import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
test('running API release is captured at startup and does not follow a later release marker change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chunmo-running-release-'));
  await mkdir(join(root, 'dist-api'));
  const file = join(root, 'dist-api', 'server.mjs');
  await build({
    entryPoints: ['server/release.ts'],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  await writeFile(join(root, '.verified-build'), 'a'.repeat(40));
  const running = await import(pathToFileURL(file).href);
  assert.equal(running.runningRelease, 'a'.repeat(40));
  await writeFile(join(root, '.verified-build'), 'b'.repeat(40));
  assert.equal(running.runningRelease, 'a'.repeat(40));
});
