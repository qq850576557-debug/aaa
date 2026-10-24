import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

// Fail visibly if native installation was skipped or the binary cannot load.
// Never print passwords, hashes, credentials, or environment configuration.
const password = randomBytes(32).toString('hex');
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
const parts = hash.split('$');
assert.equal(parts[1], 'argon2id');
assert.equal(parts[2], 'v=19');
assert.deepEqual(Object.fromEntries(parts[3].split(',').map((entry) => entry.split('='))), {
  m: '65536',
  t: '3',
  p: '1',
});
assert.equal(await argon2.verify(hash, password), true);
assert.equal(await argon2.verify(hash, password + '-incorrect'), false);
console.log(`PASS argon2: Argon2id hash/verify/reject (${process.platform}/${process.arch}).`);

if (!process.argv.includes('--production')) {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    stdin: { contents: 'export const value: number = 1;', loader: 'ts' },
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  assert.match(result.outputFiles[0].text, /value\s*=\s*1/);
  console.log(`PASS esbuild ${esbuild.version}: native TypeScript bundle.`);
}
