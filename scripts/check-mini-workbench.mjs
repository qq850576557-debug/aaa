import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const digest = (b) => createHash('sha256').update(b).digest('hex');
const m = JSON.parse(
  await readFile('miniprogram/chunmo-photo/lib/shared-workbench.manifest.json', 'utf8'),
);
assert.equal(
  digest(await readFile('miniprogram/chunmo-photo/lib/shared-workbench.js')),
  m.sha256,
  'Rebuild shared mini bundle',
);
for (const [file, sha] of Object.entries(m.sources))
  assert.equal(digest(await readFile(file)), sha, 'Shared source changed; rebuild: ' + file);
console.log('PASS mini shared bundle matches desktop business sources');
