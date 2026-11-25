import express, { type Express, type Request } from 'express';
import pg from 'pg';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner, randomToken, type AuthRequest } from './auth';
import { config } from './config';
import { transaction } from './db';
import { ApiError, audit, ownerPurchasesEnabled } from './store';
import { officialOwnerWechat, type OwnerWechat } from './owner-wechat';
import { ownerPurchaseRoutes } from './owner-purchase';

const prefix = '/api/mini-owner/v1';
const projectId = z.string().min(1).max(100);
const memberId = z.uuid();
const label = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\x00-\x1f\x7f]+$/u);
const phone = z.string().regex(/^1[3-9][0-9]{9}$/);
const token = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const loginInput = z
  .object({ loginCode: code, phoneCode: code, invite: token.optional() })
  .strict();

export type OwnerPortalOptions = { db: pg.Pool; key: string; wechat: OwnerWechat };
let configured: OwnerPortalOptions | undefined;
export function configuredOwnerPortal(): OwnerPortalOptions | undefined {
  if (process.env.CHUNMO_OWNER_PORTAL_ENABLED !== '1') return;
  if (configured) return configured;
  const {
    CHUNMO_OWNER_DATABASE_URL: url,
    CHUNMO_OWNER_DATA_KEY: key,
    CHUNMO_OWNER_WECHAT_APP_ID: appId,
    CHUNMO_OWNER_WECHAT_APP_SECRET: secret,
  } = process.env;
  if (
    !url ||
    !key ||
    !/^[a-f0-9]{64}$/i.test(key) ||
    !appId ||
    !/^wx[a-f0-9]{16}$/i.test(appId) ||
    !secret
  )
    return unavailableOwnerPortal();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return unavailableOwnerPortal();
  }
  if (
    [config.DATABASE_URL, config.PRIVATE_DATABASE_URL].some(
      (value) => new URL(value).username === parsed.username,
    )
  )
    return unavailableOwnerPortal();
  if (
    config.APP_ENV === 'test' &&
    (!parsed.pathname.endsWith('_test') || !['localhost', '127.0.0.1'].includes(parsed.hostname))
  )
    return unavailableOwnerPortal();
  return (configured = {
    db: new pg.Pool({ connectionString: url, max: 4 }),
    key,
    wechat: officialOwnerWechat(appId, secret),
  });
}

function unavailableOwnerPortal() {
  console.warn('Owner portal disabled: verify independent database and WeChat configuration');
  return undefined;
}

function crypto(key: string) {
  const master = Buffer.from(key, 'hex');
  const digest = (purpose: string, ...values: string[]) =>
    createHmac('sha256', master)
      .update(JSON.stringify([purpose, ...values]))
      .digest('hex');
  const encryption = Buffer.from(digest('owner-phone-aes-key'), 'hex');
  function sealPhone(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryption, iv);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return {
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext: encrypted.toString('hex'),
    };
  }
  return { digest, sealPhone };
}

async function ownerTransaction<T>(db: pg.Pool, run: (client: pg.PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// The caller has already verified the WeChat code against this exact AppID.
export async function boundMiniOwner(options: OwnerPortalOptions, openId: string, issue: boolean) {
  const { db, key, wechat } = options;
  const { digest } = crypto(key);
  const values = [wechat.appId, digest('wechat', wechat.appId, openId)];
  const token = issue ? randomToken() : '';
  return ownerTransaction(db, async (c) => {
    const row = (
      await c.query(
        'SELECT id,label FROM owner_portal.member WHERE app_id=$1 AND identity_digest=$2' +
          (issue ? ' FOR UPDATE' : ''),
        values,
      )
    ).rows[0];
    if (!row) return null;
    const projects = (
      await c.query(
        'SELECT id,title,phase FROM owner_portal.available_project WHERE member_id=$1 ORDER BY title,id',
        [row.id],
      )
    ).rows;
    if (!projects.length) return null;
    if (issue)
      await c.query("INSERT INTO owner_portal.session VALUES($1,$2,now()+interval '30 days')", [
        digest('session', token),
        row.id,
      ]);
    return {
      token,
      owner: { id: row.id, name: row.label },
      projects,
      purchasesEnabled: ownerPurchasesEnabled(),
    };
  });
}

export function miniOwnerRoutes(app: Express, options?: OwnerPortalOptions) {
  const router = express.Router();
  app.use(prefix, router);
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!options) throw new ApiError(404, '业主服务尚未开放');
    next();
  });
  if (!options) return;
  const { db, key, wechat } = options;
  const { digest } = crypto(key);

  async function current(req: Request) {
    const parsed = /^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization') ?? '');
    if (!parsed) throw new ApiError(401, '业主登录已失效');
    const hash = digest('session', parsed[1]);
    const row = (
      await db.query(
        `SELECT m.id,m.label FROM owner_portal.session s
       JOIN owner_portal.member m ON m.id=s.member_id
       WHERE s.digest=$1 AND s.expires_at>now()`,
        [hash],
      )
    ).rows[0];
    if (!row) throw new ApiError(401, '业主登录已失效');
    return { id: String(row.id), label: String(row.label), hash };
  }
  if (ownerPurchasesEnabled()) ownerPurchaseRoutes(router, db, current);
  router.use(express.json({ limit: '8kb' }));
  const projects = (id: string) =>
    db.query(
      'SELECT id,title,phase FROM owner_portal.available_project WHERE member_id=$1 ORDER BY title,id',
      [id],
    );
  router.post('/auth/login', async (req, res) => {
    if (!req.is('application/json')) throw new ApiError(415, '需要JSON请求');
    const body = loginInput.parse(req.body);
    const attempts = await db.query(
      `INSERT INTO owner_portal.login_limit VALUES($1,1,now()+interval '1 minute')
       ON CONFLICT(digest) DO UPDATE SET
       attempts=CASE WHEN login_limit.expires_at<=now() THEN 1 ELSE login_limit.attempts+1 END,
       expires_at=CASE WHEN login_limit.expires_at<=now() THEN now()+interval '1 minute' ELSE login_limit.expires_at END
       RETURNING attempts`,
      [digest('ip-limit', req.ip ?? '')],
    );
    if (attempts.rows[0].attempts > 8) throw new ApiError(429, '尝试过多，请稍后重试');
    const inviteHash = body.invite ? digest('invite', body.invite) : null;
    if (
      inviteHash &&
      !(
        await db.query(
          `SELECT 1 FROM owner_portal.invite i JOIN owner_portal.available_project p
       ON p.member_id=i.member_id AND p.workspace_id=i.workspace_id AND p.id=i.project_id
       WHERE i.digest=$1 AND i.consumed_at IS NULL AND i.expires_at>now()`,
          [inviteHash],
        )
      ).rowCount
    )
      throw new ApiError(403, '邀请已失效，请联系春茉');

    const verified = await wechat.verify(body.loginCode, body.phoneCode);
    const binding = digest('wechat', wechat.appId, verified.openid);
    const accessToken = randomToken();
    const person = await ownerTransaction(db, async (c) => {
      const invited = inviteHash
        ? (
            await c.query(
              'SELECT member_id,project_id,workspace_id FROM owner_portal.invite WHERE digest=$1',
              [inviteHash],
            )
          ).rows[0]
        : null;
      const row = (
        await c.query(
          `SELECT id,workspace_id,label,phone_digest,app_id,identity_digest FROM owner_portal.member
         WHERE ${inviteHash ? 'id=$1' : 'identity_digest=$1 AND app_id=$2'} FOR UPDATE`,
          inviteHash ? [invited?.member_id ?? null] : [binding, wechat.appId],
        )
      ).rows[0];
      if (
        !row ||
        row.phone_digest !== digest('phone', row.workspace_id, verified.phone) ||
        (row.identity_digest && (row.identity_digest !== binding || row.app_id !== wechat.appId))
      )
        throw new ApiError(403, '暂无访问授权或绑定不一致，请联系春茉');
      const scope = await c.query(
        'SELECT id FROM owner_portal.available_project WHERE member_id=$1 AND ($2::text IS NULL OR id=$2)',
        [row.id, invited?.project_id ?? null],
      );
      if (!scope.rowCount) throw new ApiError(403, '暂无访问授权，请联系春茉');
      if (inviteHash) {
        const consumed = await c.query(
          `UPDATE owner_portal.invite SET consumed_at=now()
           WHERE digest=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING digest`,
          [inviteHash],
        );
        if (!consumed.rowCount) throw new ApiError(403, '邀请已失效，请联系春茉');
      }
      if (!row.identity_digest)
        await c.query(
          'UPDATE owner_portal.member SET app_id=$2,identity_digest=$3,bound_at=now() WHERE id=$1',
          [row.id, wechat.appId, binding],
        );
      await c.query("INSERT INTO owner_portal.session VALUES($1,$2,now()+interval '30 days')", [
        digest('session', accessToken),
        row.id,
      ]);
      return { id: row.id, name: row.label };
    });
    res.json({
      token: accessToken,
      owner: person,
      projects: (await projects(person.id)).rows,
      ...(ownerPurchasesEnabled() ? { purchasesEnabled: true } : {}),
    });
  });
  router.post('/auth/logout', async (req, res) => {
    const member = await current(req);
    await db.query('DELETE FROM owner_portal.session WHERE digest=$1', [member.hash]);
    res.json({ ok: true });
  });
  router.get('/session', async (req, res) => {
    const member = await current(req);
    const list = (await projects(member.id)).rows;
    if (!list.length) throw new ApiError(403, '暂无访问授权，请联系春茉');
    res.json({
      owner: { id: member.id, name: member.label },
      projects: list,
      ...(ownerPurchasesEnabled() ? { purchasesEnabled: true } : {}),
    });
  });
  router.get('/projects', async (req, res) => {
    const member = await current(req);
    const list = (await projects(member.id)).rows;
    if (!list.length) throw new ApiError(403, '暂无访问授权，请联系春茉');
    res.json({ projects: list });
  });
  router.use(() => {
    throw new ApiError(404, '接口不存在');
  });
}

export function staffOwnerRoutes(app: Express, options?: OwnerPortalOptions) {
  const prefix = '/api/projects/:projectId/owner-access';
  const scope = (req: AuthRequest) =>
    [req.actor!.workspaceId, projectId.parse(req.params.projectId)] as const;
  const available = (_req: Request, _res: express.Response, next: express.NextFunction) => {
    if (!options) throw new ApiError(404, '业主服务尚未开放');
    next();
  };
  const keys = () => crypto(options!.key);
  async function lock(c: pg.PoolClient, req: AuthRequest) {
    const [workspace, project] = scope(req);
    // Serialize owner setting writes and project removal within the workspace.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 16))', [workspace]);
    const result = await c.query(
      'SELECT 1 FROM project WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE',
      [workspace, project],
    );
    if (!result.rowCount) throw new ApiError(404, '项目不存在');
    return [workspace, project] as const;
  }

  app.get('/api/owner-accounts', owner, available, async (req: AuthRequest, res) => {
    const workspace = req.actor!.workspaceId;
    const [members, projects] = await Promise.all([
      transaction((c) =>
        c.query(
          `SELECT m.id,m.label AS name,'*******' || m.phone_suffix AS "maskedPhone",
          m.identity_digest IS NOT NULL AS bound,COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id',g.project_id,'name',p.payload->>'name',
              'color',p.payload->>'color','active',g.revoked_at IS NULL,'enabled',COALESCE(s.enabled,false))
              ORDER BY p.payload->>'name',g.project_id)
            FROM owner_portal.project_grant g LEFT JOIN public.project p ON p.workspace_id=g.workspace_id AND p.id=g.project_id
            LEFT JOIN owner_portal.project_service s ON s.workspace_id=g.workspace_id AND s.project_id=g.project_id
            WHERE g.workspace_id=m.workspace_id AND g.member_id=m.id
          ),'[]'::jsonb) AS projects
        FROM owner_portal.member m WHERE m.workspace_id=$1 ORDER BY m.label,m.id`,
          [workspace],
        ),
      ),
      transaction((c) =>
        c.query(
          `SELECT p.id,p.payload->>'name' AS name,p.payload->>'color' AS color,COALESCE(s.enabled,false) AS enabled
         FROM public.project p LEFT JOIN owner_portal.project_service s ON s.workspace_id=p.workspace_id AND s.project_id=p.id
         WHERE p.workspace_id=$1 ORDER BY p.payload->>'name',p.id`,
          [workspace],
        ),
      ),
    ]);
    res.json({ members: members.rows, projects: projects.rows });
  });

  app.get(prefix, owner, available, async (req: AuthRequest, res) => {
    const data = await transaction(async (c) => {
      const [workspace, project] = await lock(c, req);
      const service = await c.query(
        'SELECT enabled FROM owner_portal.project_service WHERE workspace_id=$1 AND project_id=$2',
        [workspace, project],
      );
      const members = await c.query(
        `SELECT m.id,m.label AS name,'*******' || m.phone_suffix AS "maskedPhone",
         m.identity_digest IS NOT NULL AS bound,g.revoked_at IS NULL AS active
         FROM owner_portal.project_grant g JOIN owner_portal.member m ON m.id=g.member_id
         WHERE g.workspace_id=$1 AND g.project_id=$2 ORDER BY m.label,m.id`,
        [workspace, project],
      );
      return { enabled: service.rows[0]?.enabled === true, members: members.rows };
    });
    res.json(data);
  });
  app.put(prefix + '/service', owner, available, async (req: AuthRequest, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await transaction(async (c) => {
      const [workspace, project] = await lock(c, req);
      await c.query(
        `INSERT INTO owner_portal.project_service VALUES($1,$2,$3)
         ON CONFLICT(workspace_id,project_id) DO UPDATE SET enabled=excluded.enabled`,
        [workspace, project, enabled],
      );
      if (!enabled)
        await c.query(
          'UPDATE owner_portal.invite SET consumed_at=now() WHERE workspace_id=$1 AND project_id=$2 AND consumed_at IS NULL',
          [workspace, project],
        );
      await audit(
        c,
        req.actor!,
        enabled ? 'owner.project.enable' : 'owner.project.disable',
        undefined,
        { entityType: 'project', entityId: project, operation: 'update' },
      );
    });
    res.json({ ok: true });
  });
  app.post(prefix + '/members', owner, available, async (req: AuthRequest, res) => {
    const body = z
      .union([
        z.object({ name: label, phone, create: z.literal(true).optional() }).strict(),
        z.object({ memberId }).strict(),
      ])
      .parse(req.body);
    const { digest, sealPhone } = keys();
    const invite = randomToken();
    await transaction(async (c) => {
      const [workspace, project] = await lock(c, req);
      const row =
        'memberId' in body
          ? (
              await c.query(
                'SELECT id FROM owner_portal.member WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
                [workspace, body.memberId],
              )
            ).rows[0]
          : (
              await c.query(
                `INSERT INTO owner_portal.member(id,workspace_id,label,phone_digest,phone_sealed,phone_suffix)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,phone_digest)
         DO UPDATE SET label=owner_portal.member.label WHERE NOT $7 AND owner_portal.member.label=excluded.label RETURNING id`,
                [
                  randomUUID(),
                  workspace,
                  body.name,
                  digest('phone', workspace, body.phone),
                  sealPhone(body.phone),
                  body.phone.slice(-4),
                  body.create === true,
                ],
              )
            ).rows[0];
      if (!row) {
        if ('memberId' in body) throw new ApiError(404, '业主账号不存在');
        throw new ApiError(409, '该手机号已有业主账号，请从业主列表选择本人');
      }
      await c.query(
        `INSERT INTO owner_portal.project_grant(workspace_id,project_id,member_id) VALUES($1,$2,$3)
         ON CONFLICT(workspace_id,project_id,member_id) DO UPDATE SET revoked_at=NULL`,
        [workspace, project, row.id],
      );
      await c.query(
        'UPDATE owner_portal.invite SET consumed_at=now() WHERE member_id=$1 AND project_id=$2 AND consumed_at IS NULL',
        [row.id, project],
      );
      await c.query(
        "INSERT INTO owner_portal.invite VALUES($1,$2,$3,$4,now()+interval '24 hours',NULL)",
        [digest('invite', invite), workspace, project, row.id],
      );
      await audit(c, req.actor!, 'owner.grant.create', undefined, {
        entityType: 'owner_member',
        entityId: row.id,
        operation: 'grant',
      });
    });
    res.json({ invite });
  });
  app.delete(prefix + '/members/:memberId', owner, available, async (req: AuthRequest, res) => {
    const id = memberId.parse(req.params.memberId);
    await transaction(async (c) => {
      const [workspace, project] = await lock(c, req);
      await c.query(
        'SELECT id FROM owner_portal.member WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspace, id],
      );
      const changed = await c.query(
        'UPDATE owner_portal.project_grant SET revoked_at=now() WHERE workspace_id=$1 AND project_id=$2 AND member_id=$3 AND revoked_at IS NULL',
        [workspace, project, id],
      );
      if (!changed.rowCount) throw new ApiError(404, '授权不存在');
      await c.query(
        'UPDATE owner_portal.invite SET consumed_at=now() WHERE member_id=$1 AND project_id=$2 AND consumed_at IS NULL',
        [id, project],
      );
      await c.query(
        `DELETE FROM owner_portal.session WHERE member_id=$1 AND NOT EXISTS (
           SELECT 1 FROM owner_portal.project_grant g JOIN owner_portal.project_service s USING(workspace_id,project_id)
           WHERE g.member_id=$1 AND g.revoked_at IS NULL AND s.enabled)`,
        [id],
      );
      await audit(c, req.actor!, 'owner.grant.revoke', undefined, {
        entityType: 'owner_member',
        entityId: id,
        operation: 'revoke',
      });
    });
    res.json({ ok: true });
  });
  app.post(
    prefix + '/members/:memberId/rebind',
    owner,
    available,
    async (req: AuthRequest, res) => {
      const id = memberId.parse(req.params.memberId);
      const body = z.object({ phone: phone.optional() }).strict().parse(req.body);
      const { digest, sealPhone } = keys();
      const invite = randomToken();
      await transaction(async (c) => {
        const [workspace, project] = await lock(c, req);
        const grant = await c.query(
          'SELECT 1 FROM owner_portal.project_grant WHERE workspace_id=$1 AND project_id=$2 AND member_id=$3 AND revoked_at IS NULL',
          [workspace, project, id],
        );
        if (!grant.rowCount) throw new ApiError(404, '授权不存在');
        if (body.phone)
          await c.query(
            'UPDATE owner_portal.member SET app_id=NULL,identity_digest=NULL,bound_at=NULL,phone_digest=$3,phone_sealed=$4,phone_suffix=$5 WHERE workspace_id=$1 AND id=$2',
            [
              workspace,
              id,
              digest('phone', workspace, body.phone),
              sealPhone(body.phone),
              body.phone.slice(-4),
            ],
          );
        else
          await c.query(
            'UPDATE owner_portal.member SET app_id=NULL,identity_digest=NULL,bound_at=NULL WHERE workspace_id=$1 AND id=$2',
            [workspace, id],
          );
        await c.query('DELETE FROM owner_portal.session WHERE member_id=$1', [id]);
        await c.query(
          'UPDATE owner_portal.invite SET consumed_at=now() WHERE member_id=$1 AND consumed_at IS NULL',
          [id],
        );
        await c.query(
          "INSERT INTO owner_portal.invite VALUES($1,$2,$3,$4,now()+interval '24 hours',NULL)",
          [digest('invite', invite), workspace, project, id],
        );
        await audit(c, req.actor!, 'owner.identity.rebind', undefined, {
          entityType: 'owner_member',
          entityId: id,
          operation: 'rebind',
        });
      });
      res.json({ invite });
    },
  );
}
