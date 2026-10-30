import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store';
import { AVATAR_MIN_SIDE, AVATAR_MAX_BYTES, AVATAR_RESOLUTION_ERROR } from '../src/lib/avatar-crop';
export const avatarInput = z
  .object({
    image: z.string().max(Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 100),
    crop: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
let processing = 0;
/** Decode the actual uploaded source, orient, crop without enlargement, and encode under the existing DB bound. */
export async function validateAvatar(body: z.infer<typeof avatarInput>) {
  if (processing >= 2) throw new ApiError(429, '照片处理中，请稍后重试；已选照片和裁切位置会保留');
  processing++;
  try {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.image);
    if (!match) throw new ApiError(400, '请选择有效的 PNG、JPEG 或 WebP 原图');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > AVATAR_MAX_BYTES)
      throw new ApiError(400, '原图不能超过10MB，请选择保留高清尺寸的 JPEG 照片');
    const source = sharp(bytes, { limitInputPixels: 16000000, failOn: 'warning' });
    const meta = await source.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format || '') || (meta.pages || 1) !== 1)
      throw new ApiError(400, '请使用静态 PNG、JPEG 或 WebP 原图');
    const { data, info } = await source
      .rotate()
      .flatten({ background: '#edf3ee' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (Math.min(info.width, info.height) < AVATAR_MIN_SIDE)
      throw new ApiError(400, AVATAR_RESOLUTION_ERROR);
    const crop = body.crop || { x: 0, y: 0, width: info.width, height: info.height };
    if (crop.x + crop.width > info.width || crop.y + crop.height > info.height)
      throw new ApiError(400, '裁切区域超出原图，请重新调整位置');
    if (crop.width < AVATAR_MIN_SIDE)
      throw new ApiError(400, '裁切区域像素不足，请缩小缩放倍数，保留至少720px的实际宽度');
    if (crop.height < 360 || crop.width / crop.height > 4 || crop.height / crop.width > 4)
      throw new ApiError(400, '裁切区域过窄，请按名片照片框调整，保留清晰的实际像素');
    const image = sharp(data, { raw: info })
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
      .resize({ width: 1440, withoutEnlargement: true });
    for (const quality of [90, 84, 78, 72, 66, 60]) {
      const encoded = await image.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
      if (encoded.length <= 524288)
        return { bytes: encoded, version: createHash('sha256').update(encoded).digest('hex') };
    }
    throw new ApiError(
      400,
      '照片细节过于复杂，无法在保持高清像素的同时安全保存，请换一张高清 JPEG 照片',
    );
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, '图片无法读取或像素超过1600万，请选择有效的高清原图');
  } finally {
    processing--;
  }
}
export const avatarMime = (bytes: Buffer) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
