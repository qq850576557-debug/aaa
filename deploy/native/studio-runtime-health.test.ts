import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const failure of ['none', 'module', 'api-version', 'private-html', 'public-html'])
  test(`HTTPS acceptance rejects ${failure} mismatch without trusting SELECT 1`, () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-runtime-health-')),
      base = join(root, 'base'),
      conf = join(root, 'conf'),
      tls = join(root, 'tls'),
      bin = join(root, 'bin');
    for (const path of [base, conf, tls, bin, join(base, 'current'), join(base, 'current', 'dist')])
      mkdirSync(path);
    const sha = 'a'.repeat(40),
      html = join(base, 'current', 'dist', 'index.html');
    writeFileSync(join(base, 'current', '.verified-build'), sha);
    writeFileSync(html, '<html>verified front end</html>');
    writeFileSync(
      join(conf, 'public-https.json'),
      JSON.stringify({
        origin: 'https://example.invalid',
        certificate: join(tls, 'server.crt'),
        mode: 'public-ca',
      }),
    );
    for (const command of ['systemctl', 'openssl'])
      writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/bash
request_url="\${!#}"
if [[ $request_url == */api/health ]]; then printf '%s' "$HEALTH_JSON"; elif [[ $FAILURE == private-html && $request_url == https://localhost:8443/ ]] || [[ $FAILURE == public-html && $request_url == https://example.invalid/ ]]; then printf old; else cat "$HTML_FILE"; fi
`,
      { mode: 0o755 },
    );
    const code = readFileSync('deploy/native/health.sh', 'utf8')
      .replaceAll('/opt/chunmo-staging', base)
      .replaceAll('/etc/chunmo-staging', conf)
      .replaceAll('/etc/pki/chunmo-staging', tls);
    const result = spawnSync('bash', ['-c', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        FAILURE: failure,
        HTML_FILE: html,
        HEALTH_JSON: JSON.stringify({
          ok: true,
          release: failure === 'api-version' ? 'b'.repeat(40) : sha,
          capabilities: { studioDaily: failure !== 'module' },
        }),
      },
    });
    assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr);
    assert.equal(result.stdout.includes('PASS public HTTPS'), failure === 'none');
  });
