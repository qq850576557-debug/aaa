import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve once at startup: switching current must not relabel the old running process.
export const runningRelease = (() => {
  try {
    const file = realpathSync(fileURLToPath(import.meta.url));
    const value = readFileSync(join(dirname(file), '..', '.verified-build'), 'utf8').trim();
    return /^[a-f0-9]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
})();
