// Read-only private photo inventory. Never prints credentials, names, GPS or image bytes.
import { readdir, readFile, lstat, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const arg = process.argv[2];
if (!arg || !arg.startsWith('/'))
  throw Error('Usage: node scripts/check-photo-store.mjs /absolute/private/photo/directory');
const root = resolve(arg),
  summary = { completed: 0, pending: 0, files: 0, bytes: 0, errors: [], availableBytes: 0 };
const digest = (b) => createHash('sha256').update(b).digest('hex');
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name),
      s = await lstat(path);
    if (s.isSymbolicLink()) {
      summary.errors.push('Symbolic link refused');
      continue;
    }
    if (s.isDirectory()) {
      await walk(path);
      continue;
    }
    summary.files++;
    summary.bytes += s.size;
    if (e.name !== 'metadata.json') continue;
    try {
      const m = JSON.parse(await readFile(path, 'utf8'));
      if (!m.complete) {
        summary.pending++;
        continue;
      }
      summary.completed++;
      for (const [file, hash] of [
        ['original', m.originalHash],
        ['watermarked.jpg', m.watermarkedHash],
      ]) {
        if (!hash || digest(await readFile(join(dir, file))) !== hash)
          summary.errors.push('Completed photo missing or hash mismatch: ' + m.requestId);
      }
    } catch {
      summary.errors.push('Unreadable metadata or image (preserved)');
    }
  }
}
await walk(root);
const fs = await statfs(root);
summary.availableBytes = Number(fs.bavail) * Number(fs.bsize);
console.log(JSON.stringify(summary, null, 2));
if (summary.errors.length) process.exitCode = 1;
