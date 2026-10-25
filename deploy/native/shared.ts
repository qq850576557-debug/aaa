import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
export type Deployment = ReturnType<typeof newDeployment>;
export function newDeployment() {
  const secret = () => randomBytes(32).toString('hex');
  return {
    id: randomBytes(16).toString('hex'),
    db: 'chunmo_staging',
    host: '127.0.0.1',
    port: 5432,
    roles: {
      migrator: { name: 'cm_stg_migrator', password: secret() },
      app: { name: 'cm_stg_app', password: secret() },
      private: { name: 'cm_stg_private', password: secret() },
      backup: { name: 'cm_stg_backup', password: secret() },
    },
  };
}
export function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value))
    throw Error('Invalid managed database/role identifier');
  return '"' + value + '"';
}
export function url(c: Deployment, role: keyof Deployment['roles'], db = c.db) {
  identifier(db);
  const r = c.roles[role];
  return `postgresql://${r.name}:${r.password}@${c.host}:${c.port}/${db}`;
}
export function validate(c: Deployment) {
  if (
    !/^[a-f0-9]{32}$/.test(c.id) ||
    c.host !== '127.0.0.1' ||
    !Number.isInteger(c.port) ||
    c.port < 1024 ||
    c.port > 65535
  )
    throw Error('Invalid deployment boundary');
  identifier(c.db);
  for (const r of Object.values(c.roles)) {
    identifier(r.name);
    if (!/^[a-f0-9]{64}$/.test(r.password)) throw Error('Invalid generated credential');
  }
  if (new Set(Object.values(c.roles).map((r) => r.name)).size !== 4)
    throw Error('Roles must be separate');
  return c;
}
export function config(path: string) {
  return validate(JSON.parse(readFileSync(join(path, 'control.json'), 'utf8')));
}
export function initConfig(path: string) {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw Error('Config directory must not be a symlink');
    const c = config(path);
    for (const name of ['runtime.env', 'backup.key', 'owner.env'])
      if (!existsSync(join(path, name)))
        throw Error('Partial config: recover missing files; refusing to regenerate keys');
    if (
      !/^[a-f0-9]{64}$/.test(readFileSync(join(path, 'backup.key'), 'utf8').trim()) ||
      !/^PRIVATE_DATA_KEY=[a-f0-9]{64}$/m.test(readFileSync(join(path, 'runtime.env'), 'utf8'))
    )
      throw Error('Invalid retained keys: recover originals, never regenerate');
    return c;
  }
  const temporary = path + '.creating-' + randomBytes(5).toString('hex');
  mkdirSync(temporary, { mode: 0o700 });
  const c = newDeployment(),
    privateKey = randomBytes(32).toString('hex');
  writeFileSync(join(temporary, 'control.json'), JSON.stringify(c), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(temporary, 'backup.key'), randomBytes(32).toString('hex'), {
    mode: 0o600,
    flag: 'wx',
  });
  writeFileSync(
    join(temporary, 'owner.env'),
    `OWNER_LOGIN=studio_owner\nOWNER_PASSWORD=${randomBytes(24).toString('hex')}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(
    join(temporary, 'runtime.env'),
    `APP_ENV=production\nAPP_ORIGIN=https://localhost:8443\nAPI_PORT=4000\nDATABASE_URL=${url(c, 'app')}\nPRIVATE_DATABASE_URL=${url(c, 'private')}\nPRIVATE_DATA_KEY=${privateKey}\nTZ=Asia/Shanghai\n`,
    { mode: 0o600, flag: 'wx' },
  );
  renameSync(temporary, path);
  return c;
}
export function hba(existing: string, database: string) {
  identifier(database);
  const start = '# BEGIN CHUNMO STAGING MANAGED',
    end = '# END CHUNMO STAGING MANAGED';
  const block = `${start}\nhost ${database} all 127.0.0.1/32 scram-sha-256\nhost ${database} all ::1/128 scram-sha-256\n${end}\n`;
  if (existing.includes(start) || existing.includes(end)) {
    if (!existing.startsWith(block))
      throw Error('Managed HBA block changed or moved: review manually');
    return existing;
  }
  return block + existing;
}
export const magic = Buffer.from('CHUNMO-BACKUP-1\n');
export function encrypt(data: Buffer, key: Buffer) {
  const iv = randomBytes(12),
    header = Buffer.concat([magic, iv]),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
export function decrypt(data: Buffer, key: Buffer) {
  if (data.length < magic.length + 28 || !data.subarray(0, magic.length).equals(magic))
    throw Error('Invalid backup header');
  const header = data.subarray(0, magic.length + 12),
    d = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
  d.setAAD(header);
  d.setAuthTag(data.subarray(-16));
  return Buffer.concat([d.update(data.subarray(header.length, -16)), d.final()]);
}
export type PublicHTTPS = { origin: string; certificate: string; key: string };
export function publicHTTPS(value: unknown): PublicHTTPS {
  const c = value as PublicHTTPS;
  const u = new URL(c.origin);
  if (
    u.protocol !== 'https:' ||
    u.origin !== c.origin ||
    u.port !== '15001' ||
    !/^[a-zA-Z0-9.-]+$/.test(u.hostname) ||
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1'
  )
    throw Error('Public HTTPS requires an exact HTTPS origin on port 15001');
  for (const path of [c.certificate, c.key])
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(path)) throw Error('Unsafe public certificate path');
  return c;
}
export function readPublicHTTPS(path: string): PublicHTTPS | undefined {
  const file = join(path, 'public-https.json');
  return existsSync(file) ? publicHTTPS(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
}
export function nginx(
  root: string,
  tls: string,
  state: string,
  webPort = 8443,
  apiPort = 4000,
  external?: PublicHTTPS,
) {
  for (const path of [root, tls, state])
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(path)) throw Error('Unsafe nginx path');
  for (const port of [webPort, apiPort])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port');
  const rendered = `# Managed by chunmo native staging deploy
worker_processes 1;
pid ${state}/nginx.pid;
error_log stderr warn;
events { worker_connections 128; }
http {
  include ${root}/deploy/native/mime.types;
  default_type application/octet-stream;
  access_log off;
  server_tokens off;
  client_max_body_size 16m;
  client_body_temp_path ${state}/body;
  proxy_temp_path ${state}/proxy;
  fastcgi_temp_path ${state}/fastcgi;
  uwsgi_temp_path ${state}/uwsgi;
  scgi_temp_path ${state}/scgi;
  server {
    listen 127.0.0.1:${webPort} ssl;
    server_name localhost 127.0.0.1;
    ssl_certificate ${tls}/server.crt;
    ssl_certificate_key ${tls}/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:TLS:1m;
    root ${root}/dist;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    location /api/ {
      proxy_pass http://127.0.0.1:${apiPort};
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header Connection "";
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 90s;
    }
    location ~ /\\. { return 404; }
    location / { try_files $uri $uri/ /index.html; add_header Cache-Control no-cache; }
  }
}
`;
  if (!external) return rendered;
  const c = publicHTTPS(external),
    host = new URL(c.origin).hostname;
  const start = rendered.indexOf('  server {');
  const block = rendered
    .slice(start, rendered.lastIndexOf('\n}'))
    .replace(`listen 127.0.0.1:${webPort} ssl;`, 'listen 0.0.0.0:15001 ssl;')
    .replace(
      'server_name localhost 127.0.0.1;',
      `server_name ${host};\n    if ($host != "${host}") { return 421; }`,
    )
    .replace(`${tls}/server.crt`, c.certificate)
    .replace(`${tls}/server.key`, c.key);
  return rendered.slice(0, rendered.lastIndexOf('\n}')) + '\n' + block + '\n}\n';
}
