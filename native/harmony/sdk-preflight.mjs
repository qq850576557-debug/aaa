import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.DEVECO_SDK_HOME;
if (!root || !existsSync(root)) {
  console.error(
    'BLOCKED: no actual HarmonyOS SDK. Target confirmed by device: 6.1.1 / API24; no HAP built.',
  );
  process.exit(2);
}
const manifests = [];
function walk(dir, depth = 0) {
  if (depth > 5) return;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, item.name);
    if (item.isDirectory()) walk(p, depth + 1);
    else if (['oh-uni-package.json', 'sdk-pkg.json', 'package.json'].includes(item.name)) {
      try {
        const v = JSON.parse(readFileSync(p, 'utf8'));
        if (JSON.stringify(v).includes('6.1.1') || Number(v.apiVersion) === 24) manifests.push(p);
      } catch {}
    }
  }
}
walk(root);
if (!manifests.length) {
  console.error(
    'BLOCKED: target API24 SDK metadata not found; select/install the matching official SDK in DevEco.',
  );
  process.exit(2);
}
console.log('SDK metadata candidates:', manifests.join('\n'));
console.log('This is preflight only; Hvigor compilation and device signing still required.');
