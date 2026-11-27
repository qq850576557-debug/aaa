import { createHmac } from 'node:crypto';
import express, { type Express, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, randomToken, setCookie, type AuthRequest } from './auth';
import { saveAccountAvatar, avatarInput, avatarMime, validateAvatar } from './avatar';
import { auditDevice } from './audit';
import { config } from './config';
import { pool, transaction } from './db';
import { officialOwnerWechat, wechatOpenId } from './owner-wechat';
import { ApiError, hash } from './store';

const loginCode = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const rememberInput = z.object({ code: loginCode }).strict();
const restoreInput = rememberInput.extend({ token: z.string().regex(/^[a-f0-9]{64}$/) });
export type EmployeeWechat = {
  appId: string;
  openId: (code: string) => Promise<string>;
  phone?: (code: string) => Promise<string>;
};

export function configuredEmployeeWechat(): EmployeeWechat | undefined {
  const [appId, secret] =
    process.env.CHUNMO_MINI_APP_ID && process.env.CHUNMO_MINI_APP_SECRET
      ? [process.env.CHUNMO_MINI_APP_ID, process.env.CHUNMO_MINI_APP_SECRET]
      : [process.env.CHUNMO_OWNER_WECHAT_APP_ID, process.env.CHUNMO_OWNER_WECHAT_APP_SECRET];
  if (!appId || !/^wx[a-f0-9]{16}$/i.test(appId) || !secret) return;
  return {
    appId,
    openId: (code) => wechatOpenId(appId, secret, code),
    phone: officialOwnerWechat(appId, secret).phone,
  };
}

export function employeeRememberHash(appId: string, openId: string, token: string) {
  return createHmac('sha256', config.PRIVATE_DATA_KEY)
    .update(JSON.stringify(['mini-employee-session-v1', appId, openId, token]))
    .digest('hex');
}

export function miniEmployeeSessions(
  app: Express,
  wechat?: EmployeeWechat,
  onAvatarChanged?: (workspaceId: string) => void,
) {
  const router = express.Router();
  app.use('/api/mini-employee/v1', router);
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!wechat) throw new ApiError(404, '员工小程序暂未启用会话恢复');
    if (
      req.get('origin') ||
      !req.get('referer')?.startsWith(`https://servicewechat.com/${wechat.appId}/`)
    )
      throw new ApiError(403, '小程序请求来源不允许');
    if (
      !(req.method === 'GET' && ['/profile', '/avatar'].includes(req.path)) &&
      !req.is('application/json')
    )
      throw new ApiError(415, '需要JSON请求');
    next();
  });
  if (!wechat) return;
  router.use('/avatar', express.json({ limit: '1mb', strict: true }));
  router.use(express.json({ limit: '8kb', strict: true }));

  // A remembered token is never an employee cookie. Its distinct hash cannot
  // authenticate a website request, and exchange requires the same WeChat identity.
  async function rememberedHash(req: Request, token: string, code: string) {
    const limited = await pool.query(
      `INSERT INTO login_limit VALUES($1,1,now()+interval '1 minute')
       ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN login_limit.expires_at<=now() THEN 1 ELSE login_limit.attempts+1 END,
       expires_at=CASE WHEN login_limit.expires_at<=now() THEN now()+interval '1 minute' ELSE login_limit.expires_at END RETURNING attempts`,
      [hash('mini-employee:' + req.ip)],
    );
    if (limited.rows[0].attempts > 30) throw new ApiError(429, '请稍后重试');
    const openId = await wechat!.openId(code);
    return employeeRememberHash(wechat!.appId, openId, token);
  }

  async function lockRememberedAccount(c: PoolClient, key: string) {
    const account = await c.query(
      `SELECT a.id FROM account a JOIN auth_session s ON s.account_id=a.id
       WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active FOR UPDATE OF a`,
      [key],
    );
    return account.rows[0]?.id as string | undefined;
  }

  router.get('/profile', authenticate, async (req: AuthRequest, res) => {
    const actor = req.actor!;
    const result = await pool.query(
      `SELECT coalesce(d.name,'') AS department,coalesce(c.job_title,'') AS "jobTitle"
       FROM account a LEFT JOIN member_card c ON c.account_id=a.id AND c.workspace_id=a.workspace_id
       LEFT JOIN department d ON d.id=c.department_id AND d.workspace_id=c.workspace_id
       WHERE a.id=$1 AND a.workspace_id=$2 AND a.active`,
      [actor.id, actor.workspaceId],
    );
    if (!result.rowCount) throw new ApiError(401, '员工登录已失效，请重新登录');
    res.json({ name: actor.displayName, ...result.rows[0] });
  });
  router.get('/avatar', authenticate, async (req: AuthRequest, res) => {
    const record = (
      await pool.query('SELECT png FROM account_avatar WHERE account_id=$1', [req.actor!.id])
    ).rows[0];
    if (!record) throw new ApiError(404, '头像不存在');
    res.type(avatarMime(record.png)).send(record.png);
  });
  router.put('/avatar', authenticate, async (req: AuthRequest, res) => {
    const image = await validateAvatar(avatarInput.parse(req.body), 512);
    req.actor!.auditDevice = auditDevice(req.get('user-agent') ?? '');
    await saveAccountAvatar(req.actor!, image);
    onAvatarChanged?.(req.actor!.workspaceId);
    res.json({ version: image.version });
  });

  router.post('/remember', authenticate, async (req: AuthRequest, res) => {
    const { code } = rememberInput.parse(req.body);
    const token = randomToken();
    const key = await rememberedHash(req, token, code);
    const expiresAt = await transaction(async (c) => {
      const account = await c.query('SELECT id FROM account WHERE id=$1 AND active FOR UPDATE', [
        req.actor!.id,
      ]);
      const valid = await c.query(
        'SELECT 1 FROM auth_session WHERE token_hash=$1 AND account_id=$2 AND expires_at>now()',
        [req.tokenHash, req.actor!.id],
      );
      if (!account.rowCount || !valid.rowCount) throw new ApiError(401, '会话已失效，请登录');
      const row = await c.query(
        "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING expires_at",
        [key, req.actor!.id],
      );
      return row.rows[0].expires_at;
    });
    res.json({ token, expiresAt });
  });

  router.post('/resume', async (req, res) => {
    const { code, token } = restoreInput.parse(req.body);
    const key = await rememberedHash(req, token, code);
    const cookie = randomToken();
    const restored = await transaction(async (c) => {
      // Lock the same account row as password changes. Read the remembered
      // record again after acquiring the lock in case reset or logout raced.
      const account = await lockRememberedAccount(c, key);
      if (!account) return false;
      const valid = await c.query(
        'SELECT 1 FROM auth_session WHERE token_hash=$1 AND account_id=$2 AND expires_at>now()',
        [key, account],
      );
      if (!valid.rowCount) return false;
      await c.query(
        "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
        [hash(cookie), account],
      );
      return true;
    });
    if (!restored) {
      res.status(401).json({ error: '记住登录已失效，请重新登录', code: 'MINI_EMPLOYEE_EXPIRED' });
      return;
    }
    setCookie(res, cookie);
    res.json({ ok: true });
  });

  router.post('/forget', async (req, res) => {
    const { code, token } = restoreInput.parse(req.body);
    const key = await rememberedHash(req, token, code);
    await transaction(async (c) => {
      if (await lockRememberedAccount(c, key))
        await c.query('DELETE FROM auth_session WHERE token_hash=$1', [key]);
    });
    res.json({ ok: true });
  });
}
