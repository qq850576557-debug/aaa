// TLS configuration and signing only; no database access or application credential changes.
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nginx, publicHTTPS } from './shared';

export function validateCertificate(origin: string, pem: string, key: string, trustCA?: string) {
  publicHTTPS({ origin, certificate: '/certificate', key: '/key' });
  const host = new URL(origin).hostname;
  if (trustCA) {
    const anchor = new X509Certificate(readFileSync(trustCA));
    if (
      !anchor.ca ||
      Date.parse(anchor.validFrom) > Date.now() ||
      Date.parse(anchor.validTo) < Date.now() + 86400000
    )
      throw Error('Trust anchor must be a currently valid CA with at least 24 hours remaining');
  }
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
      ...(trustCA ? ['-trusted', trustCA] : []),
      '-untrusted',
      pem,
      ...identity,
      pem,
    ],
    { stdio: 'pipe' },
  );
  // Explicit -trusted isolates private mode from ambient OS trust anchors.
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
  trustCA?: string,
) {
  validateCertificate(origin, certificate, key, trustCA);
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
    ...(trustCA ? { mode: 'private-ca' as const, ca: join(bundle, 'ca.crt') } : {}),
  });
  writeFileSync(c.certificate, readFileSync(certificate), { mode: 0o640, flag: 'wx' });
  writeFileSync(c.key, readFileSync(key), { mode: 0o640, flag: 'wx' });
  if (c.ca) writeFileSync(c.ca, readFileSync(trustCA!), { mode: 0o644, flag: 'wx' });
  // Recheck the exact copied bytes before enabling anything.
  validateCertificate(origin, c.certificate, c.key, c.ca);
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
// Signs a distinct public-IP leaf; existing CA and localhost certificates are read-only.
export function preparePrivateCA(
  conf: string,
  tls: string,
  root: string,
  state: string,
  origin: string,
) {
  publicHTTPS({ origin, certificate: '/certificate', key: '/key' });
  const host = new URL(origin).hostname;
  if (!/^[0-9.]+$/.test(host)) throw Error('Private CA issuance requires an IPv4 origin');
  const caPath = join(tls, 'ca.crt'),
    caKey = join(tls, 'ca.key');
  if (!lstatSync(caKey).isFile()) throw Error('Original CA key must be a regular file');
  const ca = new X509Certificate(readFileSync(caPath));
  if (!ca.ca || !ca.checkPrivateKey(createPrivateKey(readFileSync(caKey))))
    throw Error('Existing CA certificate/key mismatch');
  const days = Math.min(365, Math.floor((Date.parse(ca.validTo) - Date.now()) / 86400000));
  if (Date.parse(ca.validFrom) > Date.now() || days < 2)
    throw Error('Existing CA validity is insufficient');
  // Candidates remain protected and retained for diagnostics; no CA serial files are modified.
  const work = mkdtempSync(join(tls, '.public-candidate-'));
  chmodSync(work, 0o700);
  const cnf = join(work, 'openssl.cnf');
  writeFileSync(
    cnf,
    `[req]
prompt=no
distinguished_name=dn
[dn]
CN=${host}
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
subjectAltName=IP:${host}
`,
    { mode: 0o600 },
  );
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, {
      env: { ...process.env, OPENSSL_CONF: cnf },
      stdio: 'pipe',
    });
  openssl('verify', '-x509_strict', '-check_ss_sig', '-trusted', caPath, caPath);
  const key = join(work, 'server.key'),
    csr = join(work, 'server.csr'),
    cert = join(work, 'server.crt');
  openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', key);
  chmodSync(key, 0o600);
  openssl('req', '-new', '-key', key, '-config', cnf, '-out', csr);
  openssl(
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    caPath,
    '-CAkey',
    caKey,
    '-set_serial',
    '0x' + randomBytes(16).toString('hex'),
    '-days',
    String(days),
    '-sha256',
    '-extfile',
    cnf,
    '-extensions',
    'server',
    '-out',
    cert,
  );
  validateCertificate(origin, cert, key, caPath);
  return preparePublic(conf, tls, root, state, origin, cert, key, caPath);
}
if (process.argv[1]?.endsWith('/public.mjs')) {
  try {
    const args = process.argv.slice(2);
    const paths = [
      '/etc/chunmo-staging',
      '/etc/pki/chunmo-staging',
      '/opt/chunmo-staging/current',
      '/var/lib/chunmo-staging-web',
    ] as const;
    if (args.length === 2 && args[0] === '--private-ca')
      console.log(preparePrivateCA(...paths, args[1]));
    else if (args.length === 3 && !args[0].startsWith('--'))
      console.log(preparePublic(...paths, args[0], args[1], args[2]));
    else throw Error('Expected --private-ca origin OR origin fullchain key');
  } catch {
    console.error(
      'Public HTTPS preparation refused: check exact HTTPS origin :15001, SAN, validity >=24h, matching keys and trusted chain. Private mode requires the existing valid ca.crt/ca.key; neither is regenerated. No service was changed.',
    );
    process.exitCode = 1;
  }
}
