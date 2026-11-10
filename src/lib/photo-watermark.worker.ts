import type { PhotoMeta } from './site-photo';
import { watermarkLayout } from './photo-layout';

let logo: Promise<ImageBitmap> | null = null;
function originalLogo() {
  return (logo ||= fetch('/brand/source/chunmo-original.jpg')
    .then(async (r) => {
      if (!r.ok) throw Error('原始Logo加载失败');
      return createImageBitmap(await r.blob(), {
        resizeWidth: 256,
        resizeHeight: 256,
        resizeQuality: 'high',
      });
    })
    .catch((e) => {
      logo = null;
      throw e;
    }));
}
async function render(file: Blob, meta: PhotoMeta) {
  const source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let canvas: OffscreenCanvas | undefined;
  try {
    const w = source.width,
      h = source.height;
    if (w * h > 48_000_000) throw Error('原图超过48MP安全处理上限，原图保留');
    const factor = Math.min(1, Math.sqrt(24_000_000 / (w * h)), 8192 / Math.max(w, h));
    const width = Math.round(w * factor),
      height = Math.round(h * factor);
    canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('离屏绘图不可用');
    const mark = await originalLogo();
    ctx.drawImage(source, 0, 0, width, height);
    const { scale, font, gap, pad, wrapped, boxW, boxH, x, y } = watermarkLayout(
      width,
      height,
      meta,
    );
    ctx.fillStyle = 'rgba(21,44,35,.78)';
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 14 * scale);
    ctx.fill();
    ctx.drawImage(mark, x + pad, y + pad - 5 * scale, 34 * scale, 34 * scale);
    ctx.fillStyle = '#fffdf1';
    ctx.font = `600 ${font}px sans-serif`;
    ctx.fillText('春茉设计', x + pad + 47 * scale, y + pad + font);
    ctx.font = `${font}px sans-serif`;
    wrapped.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + gap * (i + 2)));
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    const thumb = new OffscreenCanvas(240, Math.max(1, Math.round((240 * height) / width)));
    thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const thumbnail = await thumb.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    thumb.width = thumb.height = 0;
    return {
      blob,
      thumbnail,
      width,
      height,
      originalWidth: w,
      originalHeight: h,
      meta: {
        ...meta,
        outputWidth: width,
        outputHeight: height,
        originalWidth: w,
        originalHeight: h,
      },
      renderer: 'worker' as const,
    };
  } finally {
    source.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
}
self.onmessage = async (event: MessageEvent) => {
  const { id, file, meta } = event.data;
  if (!file) {
    void originalLogo().catch(() => {});
    return;
  }
  try {
    self.postMessage({ id, result: await render(file, meta) });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
