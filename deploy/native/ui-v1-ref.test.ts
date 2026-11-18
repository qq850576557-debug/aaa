import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const guard = readFileSync('deploy/native/deploy.sh', 'utf8')
  .split('# BEGIN RELEASE REF GUARD\n')[1]
  .split('# END RELEASE REF GUARD')[0];

const scenarios = [
  { name: 'independent branch with an unchanged backend', expected: 'NEXT_PHASE' },
  { name: 'missing code-only flag', codeOnly: false, error: /requires --ref/ },
  {
    name: 'ordinary release guard rejects the UI branch',
    ui: false,
    error: /outside the feature branch/,
  },
  {
    name: 'commit outside the allowed UI branch',
    untrusted: true,
    error: /outside the UI V1 branch/,
  },
  {
    name: 'active release has a different backend',
    previous: 'old-backend',
    error: /baseline differs/,
  },
  { name: 'active release is newer', previous: 'newer', error: /newer or divergent/ },
  {
    name: 'already running with healthy services',
    previous: 'same',
    expected: 'PASS UI V1 release already active',
  },
] as const;

for (const scenario of scenarios) {
  test(scenario.name, (context) => {
    const root = mkdtempSync(join(tmpdir(), 'chunmo-ui-ref-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo'),
      base = join(root, 'base');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const commit = (path: string, value: string) => {
      writeFileSync(join(repo, path), value);
      git('add', path);
      git('commit', '-m', path);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-b', 'feature');
    git('config', 'user.email', 'ui@example.invalid');
    git('config', 'user.name', 'UI fixture');
    mkdirSync(join(repo, 'server'));
    mkdirSync(join(repo, 'src'));
    const old = commit('server/app.ts', 'old backend');
    const feature = commit('server/app.ts', 'current backend');
    git('update-ref', 'refs/remotes/origin/feat/chunmo-project-manager', feature);
    const ui = commit('src/desktop.css', 'new UI');
    const next = commit('src/desktop.css', 'later commit');
    git(
      'update-ref',
      'refs/remotes/origin/feat/chunmo-ui-v1-desktop',
      'untrusted' in scenario ? feature : ui,
    );
    const previous = 'previous' in scenario ? scenario.previous : '';
    const installed =
      previous === 'same'
        ? ui
        : previous === 'old-backend'
          ? old
          : previous === 'newer'
            ? next
            : feature;
    const release = join(base, 'releases', installed);
    mkdirSync(join(release, 'deploy/native'), { recursive: true });
    symlinkSync(release, join(base, 'current'));
    writeFileSync(join(release, 'deploy/native/health.sh'), 'printf "FIXTURE_HEALTH\n"');
    const result = spawnSync(
      'bash',
      [
        '-c',
        'set -Eeuo pipefail\nfail(){ echo "$*" >&2; return 1; }\n' + guard + '\necho NEXT_PHASE',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SOURCE_REPO: repo,
          BASE: base,
          COMMIT: ui,
          CODE_ONLY: 'codeOnly' in scenario ? '0' : '1',
          UI_V1: 'ui' in scenario ? '0' : '1',
        },
      },
    );
    if ('error' in scenario) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, scenario.error);
      assert.doesNotMatch(result.stdout, /NEXT_PHASE/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(scenario.expected));
      if (previous === 'same') {
        assert.match(result.stdout, /FIXTURE_HEALTH/);
        assert.doesNotMatch(result.stdout, /NEXT_PHASE/);
      }
    }
  });
}
