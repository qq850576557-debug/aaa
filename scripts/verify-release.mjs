// Read-only artifact checks. Never copy/delete migrations or modify a database.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const approved = JSON.parse(readFileSync('deploy/native/approved-migrations.json', 'utf8'));
const files = readdirSync('server/migrations')
  .filter((x) => x.endsWith('.sql'))
  .sort();
assert.deepEqual(
  files,
  Object.keys(approved).sort(),
  'Migration inventory differs from reviewed files',
);
for (const name of files)
  assert.equal(
    createHash('sha256')
      .update(readFileSync('server/migrations/' + name))
      .digest('hex'),
    approved[name],
    'Migration checksum: ' + name,
  );
for (const name of [
  'dist/index.html',
  'dist-api/server.mjs',
  'dist-deploy/ops.mjs',
  'dist-deploy/admin.mjs',
  'deploy/native/mime.types',
])
  assert(statSync(name).size > 0, 'Missing artifact: ' + name);
assert(
  !existsSync('dist-api/migrations/migrations'),
  'Unexpected nested migration directory; inspect release rather than deleting data',
);
console.log(
  `PASS release artifacts and ${files.length} reviewed source migrations; no migration files copied or deleted.`,
);
