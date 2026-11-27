import { createHmac } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { loginInputSchema } from '../src/lib/login';
import { passwordSchema } from '../src/lib/password';
import { argon2, owner, randomToken, setCookie, type AuthRequest } from './auth';
import { config } from './config';
import { pool, transaction } from './db';
import { employeeRememberHash, type EmployeeWechat } from './mini-employee-session';
import { boundMiniOwner, type OwnerPortalOptions } from './owner-portal';
import { auditDevice } from './audit';
import { ApiError, audit, hash } from './store';

const code = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const role = z.enum(['employee', 'owner']);
const phone = z.string().regex(/^1[3-9][0-9]{9}$/);
const digest = (purpose: string, ...parts: string[]) =>
  createHmac('sha256', config.PRIVATE_DATA_KEY)
    .update(JSON.stringify([purpose, ...parts]))
    .digest('hex');
const phoneDigest = (number: string) => digest('employee-wechat-phone', number);
const wechatDigest = (appId: string, openId: string) =>
  digest('employee-wechat-identity', appId, openId);
const boundEmployee = `SELECT a.id FROM account a JOIN employee_wechat_binding b ON b.account_id=a.id
  WHERE a.active AND b.app_id=$1 AND b.identity_digest=$2`;

async function limit(bucket: string, max: number) {
  const result = await pool.query(
    `INSERT INTO login_limit VALUES($1,1,now()+interval '1 minute')
     ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN login_limit.expires_at<=now() THEN 1 ELSE login_limit.attempts+1 END,
     expires_at=CASE WHEN login_limit.expires_at<=now() THEN now()+interval '1 minute' ELSE login_limit.expires_at END RETURNING attempts`,
    [digest('mini-unified-limit', bucket)],
  );
  if (result.rows[0].attempts > max) throw new ApiError(429, '尝试过多，请稍后重试');
}

async function issueEmployee(c: PoolClient, id: string, appId: string, openId: string) {
  const cookie = randomToken();
  const token = randomToken();
  await c.query(
    "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
    [hash(cookie), id],
  );
  const remembered = await c.query(
    "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING expires_at",
    [employeeRememberHash(appId, openId, token), id],
  );
  return { cookie, token, expiresAt: remembered.rows[0].expires_at as Date };
}

function replyEmployee(res: Response, grant: Awaited<ReturnType<typeof issueEmployee>>) {
  setCookie(res, grant.cookie);
  res.json({ role: 'employee', remembered: { token: grant.token, expiresAt: grant.expiresAt } });
}

export function miniUnifiedRoutes(
  app: Express,
  enabled: boolean,
  wechat?: EmployeeWechat,
  ownerPortal?: OwnerPortalOptions,
) {
  if (!enabled || !wechat) return;
  const router = express.Router();
  app.use('/api/mini-login/v1', router);
  const owners = ownerPortal?.wechat.appId === wechat.appId ? ownerPortal : undefined;
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (
      req.get('origin') ||
      !req.get('referer')?.startsWith(`https://servicewechat.com/${wechat.appId}/`)
    )
      throw new ApiError(403, '小程序请求来源不允许');
    if (!req.is('application/json')) throw new ApiError(415, '需要JSON请求');
    next();
  });
  router.use(express.json({ limit: '8kb', strict: true }));

  async function verified(req: Request, value: string) {
    await limit('ip:' + req.ip, 40);
    return wechat!.openId(value);
  }

  router.post('/discover', async (req, res) => {
    const input = z.object({ code }).strict().parse(req.body);
    const identity = await verified(req, input.code);
    const [staff, client] = await Promise.all([
      pool.query(boundEmployee, [wechat.appId, wechatDigest(wechat.appId, identity)]),
      owners
        ? boundMiniOwner(owners, identity, false).catch((error: unknown) => ({ error }))
        : null,
    ]);
    if (client && 'error' in client && !staff.rowCount) throw client.error;
    const roles = [
      ...(staff.rowCount ? ['employee'] : []),
      ...(client && !('error' in client) ? ['owner'] : []),
    ];
    res.json({ roles, phoneBinding: !!wechat.phone, ownerBinding: !!owners });
  });

  router.post('/enter', async (req, res) => {
    const input = z.object({ code, role }).strict().parse(req.body);
    const identity = await verified(req, input.code);
    if (input.role === 'owner') {
      const grant = owners && (await boundMiniOwner(owners, identity, true));
      if (!grant) throw new ApiError(403, '暂无业主访问授权，请联系春茉');
      res.json({ role: 'owner', ...grant });
      return;
    }
    const grant = await transaction(async (c) => {
      const parameters = [wechat.appId, wechatDigest(wechat.appId, identity)];
      const row = (await c.query(boundEmployee + ' FOR UPDATE OF a', parameters)).rows[0];
      // Recheck the binding after acquiring the same lock used for reset and unlink.
      if (!row || !(await c.query(boundEmployee, parameters)).rowCount)
        throw new ApiError(403, '员工微信尚未绑定或账号已停用');
      return issueEmployee(c, row.id, wechat.appId, identity);
    });
    replyEmployee(res, grant);
  });

  let checkingPassword = 0;
  router.post('/bind-employee', async (req, res) => {
    const input = z
      .object({ code, phoneCode: code, login: loginInputSchema, password: passwordSchema })
      .strict()
      .parse(req.body);
    if (!wechat.phone) throw new ApiError(503, '员工微信绑定暂未开放');
    const identity = await verified(req, input.code);
    await limit('bind:' + input.login, 5);
    if (checkingPassword >= 2) throw new ApiError(429, '登录繁忙，请稍后重试');
    checkingPassword++;
    try {
      const number = phone.parse(await wechat.phone(input.phoneCode));
      const grant = await transaction(async (c) => {
        const a = (
          await c.query(
            'SELECT id,workspace_id,password_hash,active,login,display_name FROM account WHERE login_key=$1 FOR UPDATE',
            [input.login],
          )
        ).rows[0];
        const valid = await argon2.verify(
          a?.password_hash ?? (await dummyPassword),
          input.password,
        );
        if (!valid || !a?.active) throw new ApiError(401, '员工账号或密码不正确');
        const current = (
          await c.query('SELECT * FROM employee_wechat_binding WHERE account_id=$1', [a.id])
        ).rows[0];
        const mobile = phoneDigest(number);
        const linked = wechatDigest(wechat.appId, identity);
        if (
          (current && current.phone_digest !== mobile) ||
          (current?.identity_digest &&
            (current.identity_digest !== linked || current.app_id !== wechat.appId))
        )
          throw new ApiError(409, '手机号或微信与员工账号已有绑定不符，请联系负责人');
        if (!current?.identity_digest) {
          await c.query(
            `INSERT INTO employee_wechat_binding(account_id,phone_digest,phone_suffix,app_id,identity_digest) VALUES($1,$2,$3,$4,$5)
             ON CONFLICT(account_id) DO UPDATE SET app_id=EXCLUDED.app_id,identity_digest=EXCLUDED.identity_digest`,
            [a.id, mobile, number.slice(-4), wechat.appId, linked],
          );
          await audit(
            c,
            {
              id: a.id,
              workspaceId: a.workspace_id,
              login: a.login,
              displayName: a.display_name,
              avatarVersion: null,
              owner: false,
              auditDevice: auditDevice(req.get('user-agent') ?? ''),
            },
            'account.wechat.bind',
            undefined,
            {
              entityType: 'account',
              entityId: a.id,
              operation: 'update',
              changedFields: ['wechatBinding'],
            },
          );
        }
        return issueEmployee(c, a.id, wechat.appId, identity);
      });
      replyEmployee(res, grant);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, '手机号或微信已绑定其他员工账号，请联系负责人');
      throw error;
    } finally {
      checkingPassword--;
    }
  });
}

const dummyPassword = argon2.hash(randomToken(), { type: argon2.argon2id });

export function staffWechatAccounts(
  app: Express,
  enabled: boolean,
  revokeStreams: (id: string) => void,
) {
  if (!enabled) return;
  app.get('/api/auth/wechat-binding', async (req: AuthRequest, res) => {
    const result = await pool.query(
      'SELECT phone_suffix AS "phoneSuffix", identity_digest IS NOT NULL AS bound FROM employee_wechat_binding WHERE account_id=$1',
      [req.actor!.id],
    );
    res.json(result.rows[0] ?? { phoneSuffix: null, bound: false });
  });
  app.get('/api/accounts/wechat', owner, async (req: AuthRequest, res) => {
    const rows = await pool.query(
      `SELECT a.id,b.phone_suffix AS "phoneSuffix",COALESCE(b.identity_digest IS NOT NULL,false) AS bound
       FROM account a LEFT JOIN employee_wechat_binding b ON b.account_id=a.id WHERE a.workspace_id=$1 AND to_jsonb(a)->>'deleted_at' IS NULL`,
      [req.actor!.workspaceId],
    );
    res.json({ accounts: rows.rows });
  });
  app.delete('/api/accounts/:id', owner, async (req: AuthRequest, res) => {
    const actor = req.actor!,
      id = String(req.params.id);
    if (id === actor.id) throw new ApiError(409, '不能删除负责人账号');
    await transaction(async (c) => {
      const retired = await c.query(
        "UPDATE public.account SET deleted_at=now(),active=false WHERE workspace_id=$1 AND id=$2 AND role='employee' AND deleted_at IS NULL RETURNING id",
        [actor.workspaceId, id],
      );
      if (!retired.rowCount) {
        if (
          (
            await c.query(
              'SELECT 1 FROM public.account WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NOT NULL',
              [actor.workspaceId, id],
            )
          ).rowCount
        )
          return;
        throw new ApiError(404, '员工账号不存在');
      }
      await c.query('DELETE FROM auth_session WHERE account_id=$1', [id]);
      await c.query('DELETE FROM employee_wechat_binding WHERE account_id=$1', [id]);
      await c.query('DELETE FROM project_permission WHERE workspace_id=$1 AND account_id=$2', [
        actor.workspaceId,
        id,
      ]);
      await c.query('DELETE FROM assessment_recorder WHERE workspace_id=$1 AND account_id=$2', [
        actor.workspaceId,
        id,
      ]);
      await c.query('DELETE FROM material_operator WHERE workspace_id=$1 AND account_id=$2', [
        actor.workspaceId,
        id,
      ]);
      await audit(c, actor, 'account.delete', undefined, {
        entityType: 'account',
        entityId: id,
        operation: 'delete',
        changedFields: ['deletedAt', 'active', 'wechatBinding', 'permissions'],
      });
    });
    revokeStreams(id);
    res.json({ ok: true });
  });
  const projectAccess = '/api/accounts/:id/project-permissions';
  app.get(projectAccess, owner, async (req: AuthRequest, res) => {
    const id = String(req.params.id),
      workspace = req.actor!.workspaceId;
    const rows = await pool.query(
      `SELECT p.id,p.payload->>'name' AS name,COALESCE(g.can_write,false) AS granted
       FROM account a JOIN project p ON p.workspace_id=a.workspace_id
       LEFT JOIN project_permission g ON g.workspace_id=p.workspace_id AND g.project_id=p.id AND g.account_id=a.id
       WHERE a.workspace_id=$1 AND a.id=$2 AND to_jsonb(a)->>'deleted_at' IS NULL ORDER BY p.payload->>'name',p.id`,
      [workspace, id],
    );
    res.json({ projects: rows.rows });
  });
  app.put(projectAccess, owner, async (req: AuthRequest, res) => {
    const { project, granted } = z
      .object({ project: z.string().min(1).max(100), granted: z.boolean() })
      .strict()
      .parse(req.body);
    const id = String(req.params.id),
      workspace = req.actor!.workspaceId;
    if (req.actor!.id === id) throw new ApiError(409, '负责人已有全部项目权限');
    await transaction(async (c) => {
      const account = await c.query(
        `SELECT id FROM account a WHERE workspace_id=$1 AND id=$2 AND to_jsonb(a)->>'deleted_at' IS NULL FOR UPDATE`,
        [workspace, id],
      );
      const target = await c.query(
        'SELECT id FROM project WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE',
        [workspace, project],
      );
      if (!account.rowCount || !target.rowCount) throw new ApiError(404, '员工账号或项目不存在');
      if (granted)
        await c.query(
          `INSERT INTO project_permission(workspace_id,project_id,account_id,can_write) VALUES($1,$2,$3,true)
         ON CONFLICT(workspace_id,project_id,account_id) DO UPDATE SET can_write=true`,
          [workspace, project, id],
        );
      else
        await c.query(
          'DELETE FROM project_permission WHERE workspace_id=$1 AND project_id=$2 AND account_id=$3',
          [workspace, project, id],
        );
      await audit(c, req.actor!, 'account.project-permission.update', undefined, {
        entityType: 'account',
        entityId: id,
        operation: 'update',
        after: { project, granted },
      });
    });
    res.json({ ok: true });
  });
  app.put('/api/accounts/:id/wechat', owner, async (req: AuthRequest, res) => {
    const input = z
      .union([
        z.object({ action: z.literal('set-phone'), phone }).strict(),
        z.object({ action: z.enum(['unlink', 'clear-phone']) }).strict(),
      ])
      .parse(req.body);
    const id = String(req.params.id);
    try {
      const changed = await transaction(async (c) => {
        const account = await c.query(
          `SELECT id FROM account a WHERE workspace_id=$1 AND id=$2 AND to_jsonb(a)->>'deleted_at' IS NULL FOR UPDATE`,
          [req.actor!.workspaceId, id],
        );
        if (!account.rowCount) throw new ApiError(404, '员工账号不存在');
        const result =
          input.action === 'set-phone'
            ? await c.query(
                `INSERT INTO employee_wechat_binding(account_id,phone_digest,phone_suffix) VALUES($1,$2,$3)
                ON CONFLICT(account_id) DO UPDATE SET phone_digest=EXCLUDED.phone_digest,phone_suffix=EXCLUDED.phone_suffix,
                  app_id=NULL,identity_digest=NULL WHERE employee_wechat_binding.phone_digest<>EXCLUDED.phone_digest`,
                [id, phoneDigest(input.phone), input.phone.slice(-4)],
              )
            : input.action === 'unlink'
              ? await c.query(
                  'UPDATE employee_wechat_binding SET app_id=NULL,identity_digest=NULL WHERE account_id=$1 AND identity_digest IS NOT NULL',
                  [id],
                )
              : await c.query('DELETE FROM employee_wechat_binding WHERE account_id=$1', [id]);
        if (!result.rowCount) return false;
        await c.query('DELETE FROM auth_session WHERE account_id=$1', [id]);
        await audit(c, req.actor!, 'account.wechat.' + input.action, undefined, {
          entityType: 'account',
          entityId: id,
          operation: 'update',
          changedFields: input.action === 'unlink' ? ['wechatBinding'] : ['wechatBinding', 'phone'],
        });
        return true;
      });
      if (changed) revokeStreams(id);
      res.json({ ok: true });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, '手机号已绑定其他员工账号');
      throw error;
    }
  });
}
