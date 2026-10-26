import { PNG } from 'pngjs';
import { ApiError } from './store';
// Decode pixels and re-encode; never serve client-supplied metadata or active formats.
export function validateAvatar(value: string) {
  const prefix = 'data:image/png;base64,';
  if (!value.startsWith(prefix)) throw new ApiError(400, '头像需要有效的 PNG 图片');
  const raw = value.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ApiError(400, '图片编码无效');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length >= 2 * 1024 * 1024) throw new ApiError(400, '头像必须小于2MB');
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new ApiError(400, '图片文件无效');
  // Canvas uploads are non-interlaced. Reject Adam7 so every inflate path is
  // bounded by the small decoded dimensions (pngjs' Adam7 path is unbounded).
  if (
    bytes[28] !== 0 ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[24] !== 8 ||
    ![2, 6].includes(bytes[25])
  )
    throw new ApiError(400, '请使用标准非交错 PNG 头像');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 256 || height > 256)
    throw new ApiError(400, '头像尺寸需在256×256以内');
  try {
    const image = PNG.sync.read(bytes, { checkCRC: true });
    if (image.width !== width || image.height !== height) throw Error();
    return PNG.sync.write(image);
  } catch {
    throw new ApiError(400, '图片像素无法读取');
  }
}
