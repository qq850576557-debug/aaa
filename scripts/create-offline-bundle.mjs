import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, basename, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branch = 'feat/chunmo-project-manager';
if (!process.argv[2])
  throw Error('Usage: node scripts/create-offline-bundle.mjs <new-output-directory>');
if (git('branch', '--show-current') !== branch)
  throw Error('Expected feature branch; do not switch production branches automatically');
if (git('status', '--porcelain')) throw Error('Commit/review all changes before packaging');
const target = git('rev-parse', 'HEAD'),
  ref = 'refs/heads/' + branch;
const directory = resolve(process.argv[2]);
const rel = relative(git('rev-parse', '--show-toplevel'), directory);
if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)))
  throw Error('Use a delivery directory outside the source repository');
if (existsSync(directory))
  throw Error('Output directory exists; refusing to overwrite a previous delivery');
mkdirSync(directory, { recursive: true });
const bundle = join(directory, `chunmo-v11-${target.slice(0, 12)}-full.bundle`),
  temporary = bundle + '.partial',
  validation = join(directory, 'verified-clone.git');
git('bundle', 'create', temporary, ref);
git('bundle', 'verify', temporary);
const heads = git('bundle', 'list-heads', temporary);
if (heads !== `${target} ${ref}`) throw Error('Bundle target/ref mismatch');
git('clone', '--bare', '--branch', branch, temporary, validation);
const cloned = git('-C', validation, 'rev-parse', ref);
if (cloned !== target) throw Error('Fresh clone does not resolve to source HEAD');
git('-C', validation, 'fsck', '--full', '--strict');
const required = [
  'server/migrations/009_experience_v11.sql',
  'server/purchases.ts',
  'server/transfers.ts',
  'src/homepage.css',
  'src/components/BriefPanel.tsx',
  'src/components/PersonalCard.tsx',
];
for (const file of required) git('-C', validation, 'cat-file', '-e', target + ':' + file);
renameSync(temporary, bundle);
const bytes = readFileSync(bundle),
  sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = {
  branch,
  ref,
  targetCommit: target,
  bundle: basename(bundle),
  bytes: bytes.length,
  sha256,
  createdAt: new Date().toISOString(),
  verification: {
    bundleVerified: true,
    exactBranchHead: heads,
    freshCloneHead: cloned,
    fullHistoryFsck: true,
    requiredFiles: required,
  },
  note: 'Code only. Does not include PostgreSQL data, ignored env files or deployment keys.',
};
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
  flag: 'wx',
});
writeFileSync(join(directory, 'SHA256SUMS'), `${sha256}  ${basename(bundle)}\n`, { flag: 'wx' });
console.log(JSON.stringify(manifest, null, 2));
