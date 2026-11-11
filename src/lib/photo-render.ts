import { photoMetadata } from './photo-metadata';
import { imageDataUrl } from './photo-image';
import { encodedDimensions } from './photo-dimensions';
import { watermarkSvg, PHOTO_MAX, type PhotoMeta } from './site-photo';
import { exifCapture } from './photo-exif';
import { photoTiming } from './photo-performance';
type RenderResult = {
  blob: Blob;
  thumbnail?: Blob;
  meta: PhotoMeta;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  exifRaw?: string;
  renderer?: 'worker' | 'main';
  encodeMs?: number;
};
let worker: Worker | null = null;
let unavailable = false;
let idle: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
let leases = 0;
const thumbnailPending = new Map<
  number,
  { resolve: (blob: Blob) => void; reject: (e: Error) => void }
>();
function idleClose() {
  clearTimeout(idle);
  if (!leases && !pending.size && !thumbnailPending.size) {
    // Keep the warmed logo/worker briefly, but release its full-size surface outside capture.
    worker?.postMessage({ releaseSurface: true });
    idle = setTimeout(closeWorker, 30000);
  }
}
export function holdPhotoRenderer() {
  leases++;
  clearTimeout(idle);
  preparePhotoRenderer();
  let held = true;
  return () => {
    if (held) {
      held = false;
      leases--;
      idleClose();
    }
  };
}
type RenderOptions = { thumbnail?: boolean; provenance?: boolean };
const pending = new Map<
  number,
  { resolve: (r: RenderResult) => void; reject: (e: Error) => void }
>();
function closeWorker() {
  clearTimeout(idle);
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(Error('图像处理线程不可用，使用兼容处理'));
  pending.clear();
  for (const p of thumbnailPending.values()) p.reject(Error('缩略图线程不可用，使用兼容处理'));
  thumbnailPending.clear();
}
export function preparePhotoRenderer() {
  if (
    unavailable ||
    worker ||
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  )
    return;
  try {
    worker = new Worker(new URL('./photo-watermark.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({ data }) => {
      const thumb = thumbnailPending.get(data.id);
      if (thumb) {
        thumbnailPending.delete(data.id);
        data.error ? thumb.reject(Error(data.error)) : thumb.resolve(data.thumbnail);
        idleClose();
        return;
      }
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      data.error ? p.reject(Error(data.error)) : p.resolve(data.result);
      if (!pending.size) idleClose();
    };
    worker.onerror = () => {
      unavailable = true;
      closeWorker();
    };
    worker.postMessage({ prepare: true });
    idleClose();
  } catch {
    unavailable = true;
    closeWorker();
  }
}
let logoData: Promise<string> | null = null;
function originalLogo() {
  return (logoData ||= fetch('/brand/source/chunmo-original.jpg')
    .then(async (r) => {
      if (!r.ok) throw Error('原始Logo加载失败');
      return imageDataUrl(await r.blob());
    })
    .catch((e) => {
      logoData = null;
      throw e;
    }));
}
const image = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(Error('此浏览器无法解码原图，请使用JPEG、PNG或WebP原图'));
    i.src = src;
  });
const jobs = new Map<string, Promise<RenderResult>>();
let chain: Promise<unknown> = Promise.resolve();
/** Legacy ready photos only: one decode at a time, never regenerate their watermark. */
export function renderOutputThumbnail(file: Blob, width: number, height: number): Promise<Blob> {
  const work = chain.then(async () => {
    const factor = Math.min(1, 240 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * factor)),
      h = Math.max(1, Math.round(height * factor));
    preparePhotoRenderer();
    if (worker) {
      clearTimeout(idle);
      try {
        return await new Promise<Blob>((resolve, reject) => {
          const id = ++sequence;
          const deadline = setTimeout(() => {
            unavailable = true;
            closeWorker();
          }, 15000);
          thumbnailPending.set(id, {
            resolve: (blob) => {
              clearTimeout(deadline);
              resolve(blob);
            },
            reject: (e) => {
              clearTimeout(deadline);
              reject(e);
            },
          });
          worker!.postMessage({ id, file, thumbnailOnly: true, width: w, height: h });
        });
      } catch {
        unavailable = true;
        closeWorker();
      }
    }
    let source: ImageBitmap | HTMLImageElement | undefined;
    const canvas = document.createElement('canvas');
    try {
      try {
        source = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h });
      } catch {
        source = await image(await imageDataUrl(file));
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('缩略图暂不可用，高清照片仍保留');
      ctx.drawImage(source, 0, 0, w, h);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error('缩略图生成失败，高清照片仍保留'))),
          'image/jpeg',
          0.72,
        ),
      );
    } finally {
      if (source && 'close' in source) source.close();
      canvas.width = canvas.height = 0;
    }
  });
  chain = work.catch(() => {});
  return work;
}
export function renderPhoto(
  file: File,
  meta: PhotoMeta,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const old = jobs.get(meta.requestId);
  if (old) return old;
  const work = chain.then(() => renderOnePhoto(file, meta, options));
  jobs.set(meta.requestId, work);
  chain = work
    .catch(() => {})
    .finally(() => {
      jobs.delete(meta.requestId);
    });
  return work;
}
async function renderOnePhoto(file: File, meta: PhotoMeta, options: RenderOptions) {
  const started = performance.now();
  const header = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const dimensions = encodedDimensions(header);
  if (!file.size || file.size > PHOTO_MAX) throw Error('原图需小于50MiB，本地文件未修改');
  if (dimensions && dimensions.width * dimensions.height > 48_000_000)
    throw Error('原图超过48MP安全处理上限，请保留原图并在电脑处理');
  const exif = exifCapture(header);
  const actual = {
    ...meta,
    ...(exif && !['live-camera', 'native-camera'].includes(meta.captureSource)
      ? { capturedAt: exif.at, captureSource: 'exif' as const }
      : {}),
  };
  let result: RenderResult;
  preparePhotoRenderer();
  if (worker) {
    clearTimeout(idle);
    try {
      result = await new Promise<RenderResult>((resolve, reject) => {
        const id = ++sequence;
        const deadline = setTimeout(() => {
          unavailable = true;
          closeWorker();
        }, 45000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(deadline);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(deadline);
            reject(error);
          },
        });
        worker!.postMessage({ id, file, meta: actual, options });
      });
    } catch {
      unavailable = true;
      closeWorker();
      result = await renderCurrentPhoto(file, actual, options);
    }
  } else result = await renderCurrentPhoto(file, actual, options);
  if (result.encodeMs !== undefined)
    photoTiming('watermark-encode', performance.now() - result.encodeMs, {
      renderer: result.renderer || 'main',
    });
  photoTiming('watermark', started, {
    renderer: result.renderer || 'main',
    width: result.width,
    height: result.height,
  });
  return { ...result, exifRaw: exif?.raw };
}
async function renderCurrentPhoto(file: File, meta: PhotoMeta, options: RenderOptions) {
  if (!file.size || file.size > PHOTO_MAX) throw Error('原图需小于50MiB，本地文件未修改');
  const header = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const dimensions = encodedDimensions(header);
  if (dimensions && dimensions.width * dimensions.height > 48_000_000)
    throw Error('原图超过48MP安全处理上限，请保留原图并在电脑处理；未裁切或放大。');

  let source: ImageBitmap | HTMLImageElement | undefined;
  try {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      source = await image(await imageDataUrl(file));
    }
    const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width,
      h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    const factor = Math.min(1, Math.sqrt(24_000_000 / (w * h)), 8192 / Math.max(w, h));
    let width = Math.round(w * factor),
      height = Math.round(h * factor),
      canvas = document.createElement('canvas');
    const draw = () => {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('设备无法处理照片，请保留原图');
      ctx.drawImage(source!, 0, 0, width, height);
      return ctx;
    };
    const exif = exifCapture(header);
    const actual = {
      ...meta,
      ...(exif && !['live-camera', 'native-camera'].includes(meta.captureSource)
        ? { capturedAt: exif.at, captureSource: 'exif' as const }
        : {}),
      outputWidth: width,
      outputHeight: height,
    };
    const logoData = await originalLogo();
    async function encode() {
      actual.outputWidth = width;
      actual.outputHeight = height;
      const ctx = draw();
      const overlay = new Blob([watermarkSvg(width, height, actual, logoData)], {
        type: 'image/svg+xml',
      });
      ctx.drawImage(await image(await imageDataUrl(overlay, 'image/svg+xml')), 0, 0);
      const encodeStarted = performance.now();
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error('设备内存不足，无法生成水印，请保留原图'))),
          'image/jpeg',
          0.95,
        ),
      );
      photoTiming('watermark-encode', encodeStarted, { renderer: 'main' });
      return blob;
    }
    let blob: Blob;
    try {
      blob = await encode();
    } catch (e) {
      if (width * height <= 8_000_000) throw e;
      const f = Math.min(1, Math.sqrt(8_000_000 / (w * h)), 8192 / Math.max(w, h));
      width = Math.floor(w * f);
      height = Math.floor(h * f);
      blob = await encode();
    }

    if (options.provenance) blob = await photoMetadata(blob, actual);
    let thumbnail: Blob | undefined;
    if (options.thumbnail !== false) {
      const preview = document.createElement('canvas');
      const factor = Math.min(1, 240 / Math.max(width, height));
      preview.width = Math.max(1, Math.round(width * factor));
      preview.height = Math.max(1, Math.round(height * factor));
      preview.getContext('2d')?.drawImage(canvas, 0, 0, preview.width, preview.height);
      thumbnail = await new Promise<Blob | undefined>((resolve) =>
        preview.toBlob((b) => resolve(b || undefined), 'image/jpeg', 0.75),
      );
      preview.width = preview.height = 0;
    }
    canvas.width = canvas.height = 0;
    return {
      blob,
      meta: actual,
      width,
      height,
      originalWidth: w,
      originalHeight: h,
      exifRaw: exif?.raw,
      thumbnail,
      renderer: 'main' as const,
    };
  } finally {
    if (source && 'close' in source) source.close();
  }
}
