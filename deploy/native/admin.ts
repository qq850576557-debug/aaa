import pg from 'pg';
import { passwordSchema } from '../../src/lib/password';
import { createHmac, createHash, randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import argon2 from 'argon2';
import { config, identifier, url, validate, type Deployment } from './shared';
import { migrate } from '../../server/migrate';
import { createWorkspace } from '../../server/store';
export function scram(password: string) {
  const salt = randomBytes(16),
    salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
export async function cluster(admin: pg.Client, c: Deployment) {
  validate(c);
  const marker = 'chunmo-staging:' + c.id;
  const database = await admin.query(
    "SELECT pg_catalog.shobj_description(oid,'pg_database') AS marker,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
    [c.db],
  );
  if (
    database.rowCount &&
    (database.rows[0].marker !== marker || database.rows[0].owner !== c.roles.migrator.name)
  )
    throw Error('Existing database is not managed by this deployment; refusing adoption');
  await admin.query('BEGIN');
  try {
    for (const role of Object.values(c.roles)) {
      const prior = await admin.query(
        "SELECT pg_catalog.shobj_description(oid,'pg_authid') AS marker,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",
        [role.name],
      );
      if (prior.rowCount) {
        const r = prior.rows[0];
        if (
          (
            await admin.query(
              'SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',
              [role.name],
            )
          ).rowCount ||
          r.marker !== marker ||
          r.rolsuper ||
          r.rolcreatedb ||
          r.rolcreaterole ||
          r.rolreplication ||
          r.rolbypassrls
        )
          throw Error('Unexpected existing role privileges or ownership');
      } else {
        const query = await admin.query(
          "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text,$2::text) AS sql",
          [role.name, scram(role.password)],
        );
        await admin.query(query.rows[0].sql);
        const comment = await admin.query(
          "SELECT format('COMMENT ON ROLE %I IS %L',$1::text,$2::text) AS sql",
          [role.name, marker],
        );
        await admin.query(comment.rows[0].sql);
      }
    }
    await admin.query('COMMIT');
  } catch (e) {
    await admin.query('ROLLBACK');
    throw e;
  }
  if (!database.rowCount) {
    await admin.query(
      `CREATE DATABASE ${identifier(c.db)} OWNER ${identifier(c.roles.migrator.name)} TEMPLATE template0 ENCODING 'UTF8'`,
    );
    const comment = await admin.query(
      "SELECT format('COMMENT ON DATABASE %I IS %L',$1::text,$2::text) AS sql",
      [c.db, marker],
    );
    await admin.query(comment.rows[0].sql);
  }
  await admin.query(`REVOKE ALL ON DATABASE ${identifier(c.db)} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${identifier(c.db)} TO ${Object.values(c.roles)
      .map((r) => identifier(r.name))
      .join(',')}`,
  );
}
export async function grants(c: Deployment) {
  const approved = JSON.parse(readFileSync('deploy/native/approved-migrations.json', 'utf8'));
  for (const name of readdirSync('server/migrations').filter((x) => x.endsWith('.sql'))) {
    if (
      approved[name] !==
      createHash('sha256')
        .update(readFileSync('server/migrations/' + name))
        .digest('hex')
    )
      throw Error(
        'Unreviewed migration: update the explicit deployment migration allowlist after review',
      );
  }
  await migrate(url(c, 'migrator'));
  const db = new pg.Client({ connectionString: url(c, 'migrator') });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query(
      `GRANT CONNECT ON DATABASE ${identifier(c.db)} TO ${Object.values(c.roles)
        .map((r) => identifier(r.name))
        .join(',')}`,
    );
    const app = identifier(c.roles.app.name),
      priv = identifier(c.roles.private.name),
      backup = identifier(c.roles.backup.name);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${app},${priv},${backup}`);
    await db.query(`GRANT USAGE ON SCHEMA public TO ${app},${priv},${backup}`);
    await db.query(`GRANT SELECT ON schema_migration,cloud_workspace TO ${app}`);
    await db.query(`GRANT SELECT,UPDATE ON workspace_state TO ${app}`);
    await db.query(`GRANT SELECT,INSERT,UPDATE ON account TO ${app}`);
    await db.query(`GRANT SELECT,INSERT ON imported_archive TO ${app}`);
    await db.query(`GRANT SELECT,INSERT,DELETE ON auth_session TO ${app}`);
    await db.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON project,person,trade,task,purchase,memo,assignment,login_limit,import_preview TO ${app}`,
    );
    await db.query(`GRANT INSERT ON audit_event TO ${app},${priv}`);
    await db.query(`GRANT SELECT,INSERT,UPDATE ON person_private TO ${priv}`);
    await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backup}`);
    await db.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${backup}`);
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${backup}`);
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  for (const [kind, r] of Object.entries(c.roles)) {
    const check = new pg.Client({ connectionString: url(c, kind as keyof Deployment['roles']) });
    await check.connect();
    try {
      const q = await check.query(
        'SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
      );
      if (q.rows[0].rolsuper || q.rows[0].rolcreatedb || q.rows[0].rolcreaterole)
        throw Error('Unexpected runtime privileges');
      if (kind === 'app') {
        try {
          await check.query('SELECT * FROM person_private LIMIT 0');
          throw Error('Private SQL access unexpectedly allowed');
        } catch (e) {
          if ((e as { code?: string }).code !== '42501') throw e;
        }
      }
    } finally {
      await check.end();
    }
    const wrong = new pg.Client({
      connectionString: url(c, kind as keyof Deployment['roles']).replace(
        r.password,
        randomBytes(32).toString('hex'),
      ),
    });
    try {
      await wrong.connect();
      throw Error('PostgreSQL accepted an incorrect password; review HBA');
    } catch (e) {
      if ((e as { code?: string }).code !== '28P01') throw e;
    } finally {
      await wrong.end();
    }
  }
}
export async function owner(c: Deployment, login: string, password: string) {
  const db = new pg.Client({ connectionString: url(c, 'migrator') });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('LOCK TABLE account IN EXCLUSIVE MODE');
    if (!(await db.query('SELECT 1 FROM account LIMIT 1')).rowCount) {
      if (!/^[a-z0-9_.@-]{3,80}$/.test(login) || !passwordSchema.safeParse(password).success)
        throw Error('Invalid owner bootstrap credentials');
      await createWorkspace(
        db,
        login,
        await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
        }),
        '春茉空间设计',
      );
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
}
async function main() {
  const op = process.argv[2];
  if (op === 'cluster' || op === 'restore-db') {
    const input = JSON.parse(readFileSync(0, 'utf8')),
      c = validate(input.config);
    if (!input.socket?.startsWith('/'))
      throw Error('Peer administration requires a local Unix socket');
    const admin = new pg.Client({
      host: input.socket,
      port: c.port,
      user: 'postgres',
      database: 'postgres',
    });
    await admin.connect();
    try {
      if (op === 'cluster') await cluster(admin, c);
      else {
        if (!/^chunmo_restorecheck_[0-9]{14}_[a-f0-9]{8}$/.test(input.database))
          throw Error('Restore may only create a fresh isolated check database');
        await admin.query(
          `CREATE DATABASE ${identifier(input.database)} OWNER ${identifier(c.roles.migrator.name)} TEMPLATE template0`,
        );
        await admin.query(`REVOKE ALL ON DATABASE ${identifier(input.database)} FROM PUBLIC`);
      }
    } finally {
      await admin.end();
    }
  } else {
    const path = process.argv[3],
      c = config(path);
    if (op === 'migrate') await grants(c);
    else if (op === 'owner') {
      const values = Object.fromEntries(
        readFileSync(path + '/owner.env', 'utf8')
          .trim()
          .split('\n')
          .map((x) => x.split('=')),
      );
      await owner(c, values.OWNER_LOGIN, values.OWNER_PASSWORD);
    } else throw Error('Unsupported deployment operation');
  }
}
if (process.argv[1]?.endsWith('/admin.mjs') || process.argv[1]?.endsWith('/admin.ts')) {
  main().catch(() => {
    console.error(
      'Deployment database operation failed; existing data/keys retained. Check connectivity, ownership, HBA and migration checksums. No secrets printed.',
    );
    process.exitCode = 1;
  });
}
