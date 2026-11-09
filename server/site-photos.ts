import { exifCapture } from '../src/lib/photo-exif';
import type { Express } from 'express';
import type { AuthRequest } from './auth';
import { ApiError, getState, hash, audit } from './store';
import { transaction } from './db';
import { photoInput, PHOTO_CHUNK, type PhotoMeta } from '../src/lib/site-photo';
import { watermarkSvg } from '../src/lib/site-photo';
import { readFile, writeFile, mkdir, rename, readdir, stat, unlink, open } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const byteHash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
import sharp from 'sharp';
import { z } from 'zod';
const locks = new Map<string, Promise<unknown>>();
async function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}
async function atomic(path: string, data: string | Buffer) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, data, { mode: 0o600, flag: 'wx', flush: true });
  await rename(tmp, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function bytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new ApiError(503, '照片存储存在异常，请联系负责人');
    const p = join(dir, e.name);
    total += e.isDirectory() ? await bytes(p) : (await stat(p)).size;
  }
  return total;
}
function root() {
  const r = process.env.CHUNMO_PHOTO_DIR;
  if (!r || !isAbsolute(r)) throw new ApiError(503, '云端照片存储尚未启用，本地照片已保留');
  const p = resolve(r);
  if (p.includes('/public') || p.includes('/releases'))
    throw new ApiError(503, '照片存储目录配置无效');
  return p;
}
const uuid = z.uuid();
type Stored = PhotoMeta & {
  bodyHash: string;
  hashes: Record<string, string>;
  originalHash?: string;
  watermarkedHash?: string;
};
function paths(req: AuthRequest) {
  const a = req.actor!;
  const id = uuid.parse(req.params.id);
  const workspace = join(root(), hash(a.workspaceId));
  return { workspace, dir: join(workspace, hash(a.id), id), id };
}
async function manifest(dir: string): Promise<Stored> {
  try {
    return JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ApiError(404, '照片不存在或无权访问');
    throw new ApiError(503, '照片元数据异常，请联系负责人；原文件未改写');
  }
}
async function capacity(workspace: string, additional: number) {
  const quota = Number(process.env.CHUNMO_PHOTO_QUOTA_BYTES || 2 * 1024 ** 3);
  if (!Number.isSafeInteger(quota) || quota < 1) throw new ApiError(503, '照片配额未正确配置');
  if ((await bytes(workspace)) + additional > quota)
    throw new ApiError(507, '照片存储空间不足，本地文件已保留，请联系负责人');
}
let rendering = false;
export function sitePhotoRoutes(app: Express) {
  app.get('/api/site-photos/config', (req: AuthRequest, res) => {
    res.json({
      enabled: !!process.env.CHUNMO_PHOTO_DIR,
      actorId: req.actor!.id,
      actorName: req.actor!.displayName || req.actor!.login,
      maxBytes: 50 * 1024 ** 2,
    });
  });
  app.post('/api/site-photos', async (req: AuthRequest, res, next) => {
    try {
      const input = photoInput.parse(req.body),
        a = req.actor!;
      const workspace = join(root(), hash(a.workspaceId));
      const dir = join(workspace, hash(a.id), input.requestId);
      const result = await lock(workspace, async () => {
        const state = await transaction((c) => getState(c, a.workspaceId));
        const project = state.data.projects.find((p) => p.id === input.projectId);
        if (!project) throw new ApiError(403, '工地不存在或无权访问');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const digest = hash(JSON.stringify(input));
        let old: Stored | null = null;
        try {
          old = await manifest(dir);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
        if (old) {
          if (old.bodyHash !== digest) throw new ApiError(409, '照片请求编号已用于其他内容');
          return old;
        }
        const meta: Stored = {
          ...input,
          actorId: a.id,
          actorName: a.displayName || a.login,
          projectName: project.name,
          bodyHash: digest,
          hashes: {},
          complete: false,
        };
        await capacity(workspace, Buffer.byteLength(JSON.stringify(meta)));
        await atomic(join(dir, 'metadata.json'), JSON.stringify(meta));
        return meta;
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/site-photos/:id', async (req: AuthRequest, res, next) => {
    try {
      const { dir } = paths(req);
      res.json(await manifest(dir));
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/site-photos/:id/chunks/:index', async (req: AuthRequest, res, next) => {
    try {
      const { dir, workspace } = paths(req);
      const index = z.coerce.number().int().min(0).max(99).parse(req.params.index);
      const body = z
        .object({
          data: z
            .string()
            .min(1)
            .max(Math.ceil(PHOTO_CHUNK / 3) * 4),
        })
        .strict()
        .parse(req.body);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new ApiError(400, '照片分块无效');
      const buf = Buffer.from(body.data, 'base64');
      await lock(workspace, async () => {
        const m = await manifest(dir);
        const expected = Math.min(PHOTO_CHUNK, m.originalSize - index * PHOTO_CHUNK);
        if (expected <= 0 || buf.length !== expected) throw new ApiError(400, '照片分块长度无效');
        const digest = byteHash(buf);
        if (m.hashes[index]) {
          if (m.hashes[index] !== digest) throw new ApiError(409, '照片分块内容冲突');
          return;
        }
        if (m.complete) throw new ApiError(409, '照片已确认保存');
        await capacity(workspace, buf.length + 512);
        await atomic(join(dir, index + '.part'), buf);
        m.hashes[index] = digest;
        await atomic(join(dir, 'metadata.json'), JSON.stringify(m));
      });
      res.json({ ok: true, index });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/site-photos/:id/complete', async (req: AuthRequest, res, next) => {
    try {
      z.object({}).strict().parse(req.body);
      const { dir, workspace } = paths(req);
      const result = await lock(workspace, async () => {
        const m = await manifest(dir);
        if (m.complete) return m;
        if (rendering) throw new ApiError(429, '照片正在处理，请稍后自动重试');
        rendering = true;
        try {
          const count = Math.ceil(m.originalSize / PHOTO_CHUNK),
            parts: Buffer[] = [];
          for (let i = 0; i < count; i++) {
            if (!m.hashes[i]) throw new ApiError(409, '照片尚未完整上传');
            const b = await readFile(join(dir, i + '.part'));
            if (byteHash(b) !== m.hashes[i]) throw new ApiError(409, '照片分块校验失败');
            parts.push(b);
          }
          const original = Buffer.concat(parts);
          if (original.length !== m.originalSize) throw new ApiError(400, '原图尺寸无效');
          const exif = exifCapture(original);
          if (exif) m.exifRaw = exif.raw;
          if (m.captureSource === 'exif' && (!exif || exif.at !== m.capturedAt))
            throw new ApiError(400, '原图拍摄时间与EXIF不一致');
          const meta = await sharp(original, { limitInputPixels: 48_000_000 }).metadata();
          if (
            !['jpeg', 'png', 'webp', 'heif'].includes(meta.format || '') ||
            !meta.width ||
            !meta.height
          )
            throw new ApiError(415, '不支持的照片格式');
          const rotated = (meta.orientation ?? 1) >= 5;
          const ow = rotated ? meta.height : meta.width,
            oh = rotated ? meta.width : meta.height;
          if (
            m.outputWidth > ow ||
            m.outputHeight > oh ||
            Math.abs(m.outputWidth / m.outputHeight - ow / oh) > 0.01
          )
            throw new ApiError(400, '水印图不能拉伸、裁切或放大原图');
          const logo =
            'data:image/jpeg;base64,' +
            (await readFile('public/brand/source/chunmo-original.jpg')).toString('base64');
          // Actor and project name come from authenticated server state, never from client fields.
          const watermark = await sharp(original, { limitInputPixels: 48_000_000 })
            .rotate()
            .resize(m.outputWidth, m.outputHeight, { fit: 'fill', withoutEnlargement: true })
            .composite([
              { input: Buffer.from(watermarkSvg(m.outputWidth, m.outputHeight, m, logo)) },
            ])
            .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
            .toBuffer();
          await capacity(workspace, original.length + watermark.length + 2048);
          await atomic(join(dir, 'original'), original);
          await atomic(join(dir, 'watermarked.jpg'), watermark);
          m.originalWidth = ow;
          m.originalHeight = oh;
          m.originalHash = byteHash(original);
          m.watermarkedHash = byteHash(watermark);
          m.uploadedAt = await transaction(async (c) => {
            const find = () =>
              c.query(
                "SELECT created_at FROM audit_event WHERE workspace_id=$1 AND actor_id=$2 AND entity_type='site-photo' AND entity_id=$3 AND action='photo.create' ORDER BY created_at LIMIT 1",
                [req.actor!.workspaceId, req.actor!.id, m.requestId],
              );
            let prior = await find();
            if (!prior.rowCount) {
              await audit(c, req.actor!, 'photo.create', undefined, {
                entityType: 'site-photo',
                entityId: m.requestId,
                operation: 'create',
                after: {
                  projectId: m.projectId,
                  capturedAt: m.capturedAt,
                  captureSource: m.captureSource,
                  originalWidth: ow,
                  originalHeight: oh,
                  outputWidth: m.outputWidth,
                  outputHeight: m.outputHeight,
                  originalHash: m.originalHash,
                  watermarkedHash: m.watermarkedHash,
                },
                changedFields: ['original', 'watermarked', 'capture'],
              });
              prior = await find();
            }
            return new Date(prior.rows[0].created_at).toISOString();
          });
          m.complete = true;
          await atomic(join(dir, 'metadata.json'), JSON.stringify(m));
          // Only verified redundant transport chunks are removed; both business image files remain.
          for (let i = 0; i < count; i++) await unlink(join(dir, i + '.part')).catch(() => {});
          return m;
        } finally {
          rendering = false;
        }
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  // Workspace-wide collaboration is the existing project permission model. No public file serving.
  app.get('/api/site-photos/:actor/:id/:kind', async (req: AuthRequest, res, next) => {
    try {
      const actor = z.string().min(1).max(100).parse(req.params.actor),
        id = uuid.parse(req.params.id);
      const kind = z.enum(['original', 'watermarked']).parse(req.params.kind);
      const dir = join(root(), hash(req.actor!.workspaceId), hash(actor), id);
      const m = await manifest(dir);
      if (!m.complete) throw new ApiError(409, '照片尚未确认保存');
      const b = await readFile(join(dir, kind === 'original' ? 'original' : 'watermarked.jpg'));
      if (byteHash(b) !== (kind === 'original' ? m.originalHash : m.watermarkedHash))
        throw new ApiError(503, '照片文件校验失败，请联系负责人');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="chunmo-${id}-${kind}${kind === 'watermarked' ? '.jpg' : ''}"`,
      );
      res.type(kind === 'watermarked' ? 'image/jpeg' : 'application/octet-stream').send(b);
    } catch (e) {
      next(e);
    }
  });
}
