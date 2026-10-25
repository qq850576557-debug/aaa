// Public listener configuration only: no database access or credential generation.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nginx, publicHTTPS } from './shared';

export function validateCertificate(origin: string, pem: string, key: string, testCA?: string) {
  publicHTTPS({ origin, certificate: '/certificate', key: '/key' });
  const host = new URL(origin).hostname;
  const cert = new X509Certificate(readFileSync(pem));
  const privateKey = createPrivateKey(readFileSync(key));
  if (cert.ca || !cert.checkPrivateKey(privateKey)) throw Error('Leaf/key mismatch or CA leaf');
  if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) < Date.now() + 86400000)
    throw Error('Public certificate must be currently valid for at least 24 hours');
  const isIP = /^[0-9.]+$/.test(host);
  if (!(isIP ? cert.checkIP(host) : cert.checkHost(host, { subject: 'never' })))
    throw Error('Public certificate requires a matching SAN');
  const identity = isIP ? ['-verify_ip', host] : ['-verify_hostname', host];
  execFileSync(
    'openssl',
    [
      'verify',
      '-x509_strict',
      '-purpose',
      'sslserver',
      ...(testCA ? ['-CAfile', testCA] : []),
      '-untrusted',
      pem,
      ...identity,
      pem,
    ],
    { stdio: 'pipe' },
  );
  // Check the complete chain using system trust; no custom CA accepted by the CLI.
  return cert.fingerprint256;
}
export function preparePublic(
  conf: string,
  tls: string,
  root: string,
  state: string,
  origin: string,
  certificate: string,
  key: string,
) {
  validateCertificate(origin, certificate, key);
  const environment = readFileSync(join(conf, 'runtime.env'), 'utf8');
  if (
    (environment.match(/^APP_ORIGIN=.*$/gm) ?? []).length !== 1 ||
    !/^APP_ENV=production$/m.test(environment)
  )
    throw Error('Expected one managed production APP_ORIGIN; no changes made');
  const bundle = mkdtempSync(join(tls, 'public-'));
  chmodSync(bundle, 0o750);
  const c = publicHTTPS({
    origin,
    certificate: join(bundle, 'fullchain.pem'),
    key: join(bundle, 'server.key'),
  });
  writeFileSync(c.certificate, readFileSync(certificate), { mode: 0o640, flag: 'wx' });
  writeFileSync(c.key, readFileSync(key), { mode: 0o640, flag: 'wx' });
  // Recheck the exact copied bytes before enabling anything.
  validateCertificate(origin, c.certificate, c.key);
  writeFileSync(
    join(bundle, 'runtime.env'),
    environment.replace(/^APP_ORIGIN=.*$/m, `APP_ORIGIN=${origin}`),
    { mode: 0o600 },
  );
  writeFileSync(join(bundle, 'public-https.json'), JSON.stringify(c), { mode: 0o600 });
  writeFileSync(join(bundle, 'nginx.conf'), nginx(root, tls, state, 8443, 4000, c), {
    mode: 0o644,
  });
  return bundle;
}
if (process.argv[1]?.endsWith('/public.mjs')) {
  try {
    const [origin, certificate, key] = process.argv.slice(2);
    if (process.argv.length !== 5) throw Error('Expected origin fullchain key');
    console.log(
      preparePublic(
        '/etc/chunmo-staging',
        '/etc/pki/chunmo-staging',
        '/opt/chunmo-staging/current',
        '/var/lib/chunmo-staging-web',
        origin,
        certificate,
        key,
      ),
    );
  } catch {
    console.error(
      'Public HTTPS preparation refused: check HTTPS origin :15001, system-trusted full chain, SAN, validity >=24h and matching key. No service was changed.',
    );
    process.exitCode = 1;
  }
}
