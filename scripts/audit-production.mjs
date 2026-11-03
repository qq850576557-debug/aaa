// Retry unavailable registry audits; never accept missing results or vulnerabilities.
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

export async function auditProduction(run, wait = setTimeout, log = console.error) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run();
    let report;
    try {
      report = JSON.parse(result.stdout || '');
    } catch {
      /* unavailable audit */
    }
    const counts = report?.metadata?.vulnerabilities;
    if (counts && Number.isInteger(counts.total) && counts.total >= 0 && !report.error) {
      if (counts.total > 0) {
        log(result.stdout);
        log('Production dependency vulnerabilities detected; deployment blocked.');
        return 1;
      }
      if (result.status === 0) {
        log('PASS production dependency audit: 0 vulnerabilities.');
        return 0;
      }
    }
    const code =
      result.error?.code ?? report?.error?.code ?? result.signal ?? `EXIT_${result.status}`;
    const safeCode = /^[A-Z0-9_-]{1,40}$/.test(String(code))
      ? String(code)
      : 'INVALID_AUDIT_RESPONSE';
    log(
      `Production audit unavailable (attempt ${attempt}/3, ${safeCode}); no security result accepted.`,
    );
    if (attempt < 3) await wait(attempt * 2000);
  }
  log(
    'Production audit unavailable after 3 attempts; deployment blocked. Retry update when registry connectivity recovers.',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exitCode = await auditProduction(() =>
    spawnSync(
      'npm',
      [
        'audit',
        '--omit=dev',
        '--json',
        '--registry=https://registry.npmjs.org',
        '--fetch-retries=0',
        '--fetch-timeout=30000',
      ],
      {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`,
        },
      },
    ),
  );
}
