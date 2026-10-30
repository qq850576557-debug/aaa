export const AVATAR_MIN_SIDE = 720;
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const AVATAR_RESOLUTION_ERROR = '图片分辨率不足，请选择短边至少为720px的高清原图。';
export type Crop = { x: number; y: number; width: number; height: number };
export function cropGeometry(
  width: number,
  height: number,
  aspect: number,
  zoom: number,
  x: number,
  y: number,
): Crop {
  const fullW = Math.min(width, height * aspect),
    fullH = fullW / aspect;
  // Avoid a floating-point value such as 719.999999999 at the permitted zoom limit.
  const w = Math.floor(fullW / zoom + 1e-7),
    h = Math.floor(fullH / zoom + 1e-7);
  return {
    x: Math.round((width - w) * Math.max(0, Math.min(1, x))),
    y: Math.round((height - h) * Math.max(0, Math.min(1, y))),
    width: w,
    height: h,
  };
}
export function maxCropZoom(width: number, height: number, aspect: number) {
  const w = Math.min(width, height * aspect);
  return w / AVATAR_MIN_SIDE;
}
