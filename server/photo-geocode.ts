import type { Express } from 'express';
import type { AuthRequest } from './auth';
import type { Actor } from './store';
import { ApiError } from './store';
import { config } from './config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  locationSchema,
  freshLocation,
  nearbyPlace,
  wgsToGcj,
  type PlaceReceipt,
} from '../src/lib/photo-location';
export const geocodeEnabled = () =>
  process.env.CHUNMO_AMAP_ENABLED === '1' && !!process.env.CHUNMO_AMAP_KEY;
const mac = (text: string) =>
  createHmac('sha256', config.PRIVATE_DATA_KEY)
    .update('chunmo-photo-location-v1:' + text)
    .digest('base64url');
export function signPlace(actor: Actor, place: Omit<PlaceReceipt, 'token'>): PlaceReceipt {
  const payload = Buffer.from(
    JSON.stringify({ ...place, actorId: actor.id, workspaceId: actor.workspaceId }),
  ).toString('base64url');
  return { ...place, token: payload + '.' + mac(payload) };
}
export function verifyPlace(token: string, actor: Actor, capturedAt: string): PlaceReceipt {
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) throw new ApiError(400, '定位凭据无效');
  const expected = mac(payload),
    a = Buffer.from(signature),
    b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(400, '定位凭据无效');
  let p: any;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw new ApiError(400, '定位凭据无效');
  }
  if (p.actorId !== actor.id || p.workspaceId !== actor.workspaceId)
    throw new ApiError(403, '定位凭据不属于当前账号');
  const at = Date.parse(capturedAt),
    obtained = Date.parse(p.location?.obtainedAt);
  if (
    !Number.isFinite(at) ||
    at < obtained - 5000 ||
    at > Date.parse(p.expiresAt) ||
    !freshLocation(p.location, Math.max(at, obtained))
  )
    throw new ApiError(409, '拍摄时定位已过期，原图保留，请重新定位拍摄');
  return { ...p, token };
}
let day = '',
  requests = 0;
export function photoGeocodeRoutes(app: Express) {
  app.post('/api/site-photos/location', async (req: AuthRequest, res, next) => {
    try {
      if (!geocodeEnabled())
        throw new ApiError(503, '地点识别尚未配置，请负责人配置已批准的高德Web服务Key后再拍照');
      const { location } = z.object({ location: locationSchema }).strict().parse(req.body);
      if (!freshLocation(location) || Date.now() - Date.parse(location.obtainedAt) > 30_000)
        throw new ApiError(400, '定位不够新鲜或精度超过100米，请重新定位');
      const today = new Date().toISOString().slice(0, 10);
      if (day !== today) {
        day = today;
        requests = 0;
      }
      const limit = Number(process.env.CHUNMO_AMAP_DAILY_LIMIT || 200);
      if (!Number.isInteger(limit) || limit < 1 || requests >= limit)
        throw new ApiError(429, '地点识别请求达到本机安全限额，请稍后重试');
      requests++;
      const point = wgsToGcj(location.latitude, location.longitude);
      const u = new URL('https://restapi.amap.com/v3/geocode/regeo');
      u.search = new URLSearchParams({
        key: process.env.CHUNMO_AMAP_KEY!,
        location: `${point.longitude},${point.latitude}`,
        extensions: 'all',
        radius: '200',
        output: 'JSON',
      }).toString();
      let raw: any;
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw Error();
        raw = await r.json();
      } catch {
        throw new ApiError(503, '地点识别服务暂不可用，请重试定位');
      }
      if (raw?.status !== '1')
        throw new ApiError(503, '地点识别服务配置或配额异常，请负责人检查高德控制台');
      const found = nearbyPlace(raw);
      if (!found) throw new ApiError(422, '未识别到可靠的小区或楼宇名称，请重试定位或等待地址识别');
      if (!freshLocation(location)) throw new ApiError(409, '定位已过期，请重试');
      res.json(
        signPlace(req.actor!, {
          location,
          placeName: found.name,
          placeSource: found.source,
          nearby: true,
          resolvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.parse(location.obtainedAt) + 90_000).toISOString(),
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
