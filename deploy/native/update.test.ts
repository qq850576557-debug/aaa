import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
test('updater executes latest pinned installer, retains dirty and divergent source, and never uses current release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-update-')),
    repo = join(dir, 'repo'),
    bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'feat/chunmo-project-manager');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/qq850576557-debug/aaa.git');
  mkdirSync(join(repo, 'deploy/native'), { recursive: true });
  writeFileSync(
    join(repo, 'deploy/native/deploy.sh'),
    '#!/bin/bash\nset -eu\n[[ $1 == --ref && $2 == "$(git -C "$CHUNMO_SOURCE_REPO" rev-parse origin/feat/chunmo-project-manager)" ]]\nprintf latest > "$RESULT"\n',
  );
  git('add', '.');
  git('commit', '-m', 'remote');
  const remote = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/feat/chunmo-project-manager', remote);
  writeFileSync(join(repo, 'local'), 'local commit');
  git('add', '.');
  git('commit', '-m', 'local-only');
  const local = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'local'), 'uncommitted retained');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/bash\nif [[ " $* " == *" fetch "* ]]; then exit 0; fi\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  // Isolate only root/lock host prerequisites; the shipped archive/pin flow runs unchanged.
  const source = readFileSync('deploy/native/update.sh', 'utf8');
  assert.match(source, /EUID == 0/);
  writeFileSync(
    join(dir, 'update.sh'),
    source
      .replace('[[ $EUID == 0 ]]', 'true')
      .replace('/run/lock/chunmo-staging-update.lock', join(dir, 'update.lock')),
  );
  execFileSync('bash', [join(dir, 'update.sh')], {
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      CHUNMO_SOURCE_REPO: repo,
      RESULT: join(dir, 'result'),
    },
  });
  assert.equal(readFileSync(join(dir, 'result'), 'utf8'), 'latest');
  assert.equal(git('rev-parse', 'HEAD'), local);
  assert.equal(readFileSync(join(repo, 'local'), 'utf8'), 'uncommitted retained');
});
test('nginx temporary permissions repair is repeatable, preserves contents and refuses symlinks', () => {
  const script = resolve('deploy/native/prepare-web-state.py');
  execFileSync('python3', [
    '-c',
    `import importlib.util,tempfile,pathlib,os,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('prepare',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b=pathlib.Path(tempfile.mkdtemp())/'web';b.mkdir();(b/'proxy').mkdir();(b/'proxy'/'pending').write_text('retained')
m.prepare(b,os.getuid(),os.getgid());m.prepare(b,os.getuid(),os.getgid())
assert (b/'proxy'/'pending').read_text()=='retained'
for name in ('body','proxy','fastcgi','scgi','uwsgi'): assert ((b/name).stat().st_mode & 0o777)==0o700
(b/'body'/'unsafe').symlink_to('/tmp')
try: m.prepare(b,os.getuid(),os.getgid());raise AssertionError('accepted symlink')
except (ValueError,OSError): pass
`,
  ]);
  const units = readFileSync('deploy/native/render-units.py', 'utf8');
  assert.match(units, /ExecStartPre=\+\/usr\/bin\/python3 .*prepare-web-state.py/);
  assert.match(units, /MemoryMax=640M/);
});

test('restart permission helper remains available when current rolls back to an older release', () => {
  const unit = readFileSync('deploy/native/render-units.py', 'utf8');
  assert.match(unit, /ExecStartPre=\+\/usr\/bin\/python3 \{base\}\/prepare-web-state.py/);
  assert.ok(!unit.includes('current/deploy/native/prepare-web-state.py'));
  const deploy = readFileSync('deploy/native/deploy.sh', 'utf8');
  assert.ok(deploy.indexOf('"$BASE/prepare-web-state.py"') < deploy.indexOf('PROMOTED=1'));
});
