import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler } from 'express';

/** Restricted transport adapter, NOT an alternative account authentication mechanism.
 * wx.login proves the configured Mini Program; existing employee cookie + CSRF still
 * authenticate every protected request. Disabled unless explicitly configured. */
export const miniPhotoRoutes: Record<string, string> = {
  'POST /login': '/api/auth/login',
  'GET /session': '/api/auth/session',
  'POST /logout': '/api/auth/logout',
  'GET /identity': '/api/site-photos/config',
  'POST /nearby': '/api/site-photos/location',
  'POST /renew': '/api/site-photos/place',
};
type Options = {
  enabled: boolean;
  appId: string;
  appSecret: string;
  signingKey: string;
  origin: string;
  exchange?: (code: string) => Promise<{ openid?: string; errcode?: number }>;
  now?: () => number;
};
export function createMiniPhotoGateway(options: Options): RequestHandler {
  const now = options.now ?? Date.now;
  const mac = (text: string) =>
    createHmac('sha256', options.signingKey)
      .update('chunmo-mini-photo-v1:' + text)
      .digest('base64url');
  const limits = new Map<string, { at: number; count: number }>();
  let active = 0;
  const exchange =
    options.exchange ??
    (async (code: string) => {
      const u = new URL('https://api.weixin.qq.com/sns/jscode2session');
      u.search = new URLSearchParams({
        appid: options.appId,
        secret: options.appSecret,
        js_code: code,
        grant_type: 'authorization_code',
      }).toString();
      const response = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw Error('exchange');
      // Never log the URL, session_key, code, openid, cookie or proof.
      const body = await response.text();
      if (body.length > 8192) throw Error('exchange');
      return JSON.parse(body) as { openid?: string; errcode?: number };
    });
  const json = express.json({ limit: '8kb', strict: true });
  return (req, res, next) => {
    if (!req.path.startsWith('/api/mini-photo/')) return next();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (
      !options.enabled ||
      !/^wx[a-zA-Z0-9]{16}$/.test(options.appId) ||
      !options.appSecret ||
      options.signingKey.length < 32
    ) {
      res.status(404).json({ error: '小程序拍照服务尚未启用' });
      return;
    }
    // Referer is set by WeChat; the bearer proof additionally requires a real,
    // one-use wx.login code. Neither a Referer nor a client-supplied Origin suffices.
    const referer = req.get('referer') ?? '';
    if (req.get('origin') || !referer.startsWith(`https://servicewechat.com/${options.appId}/`)) {
      res.status(403).json({ error: '小程序请求来源不允许' });
      return;
    }
    const path = req.path.slice('/api/mini-photo'.length);
    if (
      req.url.includes('?') ||
      (path !== '/bootstrap' && !miniPhotoRoutes[req.method + ' ' + path])
    ) {
      res.status(404).json({ error: '小程序接口不存在' });
      return;
    }
    if (path === '/bootstrap') {
      if (req.method !== 'POST' || !req.is('application/json')) {
        res.status(415).json({ error: '需要JSON请求' });
        return;
      }
      json(req, res, (err) => {
        if (err) {
          res.status(400).json({ error: '微信凭据格式不正确' });
          return;
        }
        void (async () => {
          const code = req.body?.code;
          if (
            typeof code !== 'string' ||
            code.length < 1 ||
            code.length > 256 ||
            Object.keys(req.body).length !== 1
          ) {
            res.status(400).json({ error: '微信凭据格式不正确' });
            return;
          }
          for (const [key, value] of limits) if (now() - value.at > 60000) limits.delete(key);
          const ip = req.ip ?? 'unknown';
          for (const key of [ip, '*']) {
            const bucket = limits.get(key) ?? { at: now(), count: 0 };
            bucket.count++;
            limits.set(key, bucket);
            if (bucket.count > (key === '*' ? 200 : 20) || limits.size > 10000 || active >= 4) {
              res.status(429).json({ error: '微信验证繁忙，请稍后再试' });
              return;
            }
          }
          active++;
          try {
            const verified = await exchange(code);
            if (verified.errcode || !verified.openid || verified.openid.length > 128)
              throw Error('invalid code');
            const expiresAt = now() + 10 * 60 * 1000;
            // No user mapping, additional table or durable WeChat identity store.
            const body = Buffer.from(
              JSON.stringify({
                appId: options.appId,
                expiresAt,
                nonce: randomBytes(16).toString('hex'),
              }),
            ).toString('base64url');
            res.json({ proof: body + '.' + mac(body), expiresAt });
          } catch {
            res
              .status(401)
              .json({ error: '微信验证失败，请重新登录；若持续失败请联系负责人检查小程序配置' });
          } finally {
            active--;
          }
        })().catch(next);
      });
      return;
    }
    try {
      const proof = req.get('X-Chunmo-Mini-Proof') ?? '';
      if (proof.length > 2048) throw Error();
      const [body, signature, ...extra] = proof.split('.');
      if (!body || !signature || extra.length) throw Error();
      const a = Buffer.from(signature),
        b = Buffer.from(mac(body));
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw Error();
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (
        parsed.appId !== options.appId ||
        !Number.isFinite(parsed.expiresAt) ||
        parsed.expiresAt <= now() ||
        parsed.expiresAt > now() + 600000
      )
        throw Error();
    } catch {
      res.status(401).json({ error: '微信验证已失效，请重新验证', code: 'MINI_PROOF_EXPIRED' });
      return;
    }
    // Only after cryptographic verification, translate this exact allowlisted
    // transport request. The original Origin gate, employee login throttling,
    // session permissions and CSRF middleware below remain unchanged.
    req.url = miniPhotoRoutes[req.method + ' ' + path]!;
    req.headers.origin = options.origin;
    next();
  };
}
