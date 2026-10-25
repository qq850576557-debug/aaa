import argon2 from 'argon2';
import { randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool, privatePool } from './db';
import { config } from './config';
import { ApiError, hash, type Actor } from './store';
export const passwordHash = (password: string) =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const randomToken = () => randomBytes(32).toString('hex');
export type AuthRequest = Request & { actor?: Actor; tokenHash?: string; token?: string };
export const cookieName = 'chunmo_session';
export function tokenFrom(req: Request) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1) ?? ''
  );
}
export async function session(tokenHash: string) {
  const q = await pool.query(
    `SELECT a.id,a.workspace_id,a.login,COALESCE(NULLIF(a.display_name,''),a.login) AS display_name,(w.owner_account_id=a.id) AS owner FROM auth_session s JOIN account a ON a.id=s.account_id JOIN cloud_workspace w ON w.id=a.workspace_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=true`,
    [tokenHash],
  );
  const a = q.rows[0];
  return a
    ? ({
        id: a.id,
        workspaceId: a.workspace_id,
        login: a.login,
        displayName: a.display_name,
        owner: a.owner,
      } as Actor)
    : null;
}
export async function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const token = tokenFrom(req);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, '请登录');
    const tokenHash = hash(token),
      actor = await session(tokenHash);
    if (!actor) throw new ApiError(401, '会话已失效，请登录');
    req.actor = actor;
    req.tokenHash = tokenHash;
    req.token = token;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const csrf = req.get('X-CSRF-Token') ?? '',
        expected = hash('csrf:' + token);
      if (
        !/^[a-f0-9]{64}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))
      )
        throw new ApiError(403, '请求验证失败');
    }
    next();
  } catch (e) {
    next(e);
  }
}
export function owner(req: AuthRequest, _res: Response, next: NextFunction) {
  req.actor?.owner ? next() : next(new ApiError(403, '仅工作室负责人可执行'));
}
export function setCookie(res: Response, token: string, clear = false) {
  res.cookie(cookieName, clear ? '' : token, {
    httpOnly: true,
    secure: config.APP_ENV === 'production' || config.APP_ORIGIN.startsWith('https:'),
    sameSite: 'strict',
    path: '/api',
    maxAge: clear ? 0 : 8 * 60 * 60 * 1000,
  });
}
export function seal(data: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(config.PRIVATE_DATA_KEY, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}
export function unseal(value: { iv: string; tag: string; ciphertext: string }) {
  const d = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.PRIVATE_DATA_KEY, 'hex'),
    Buffer.from(value.iv, 'hex'),
  );
  d.setAuthTag(Buffer.from(value.tag, 'hex'));
  return JSON.parse(
    Buffer.concat([d.update(Buffer.from(value.ciphertext, 'hex')), d.final()]).toString(),
  );
}
export { argon2, privatePool };
