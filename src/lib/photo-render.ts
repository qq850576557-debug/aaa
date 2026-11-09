import { encodedDimensions } from './photo-dimensions';
import { watermarkSvg, PHOTO_MAX, type PhotoMeta } from './site-photo';
import { exifCapture } from './photo-exif';
const image = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(Error('此浏览器无法解码原图，请使用JPEG、PNG或WebP原图'));
    i.src = src;
  });
export async function renderPhoto(file: File, meta: PhotoMeta) {
  if (!file.size || file.size > PHOTO_MAX) throw Error('原图需小于50MiB，本地文件未修改');
  const header = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const dimensions = encodedDimensions(header);
  if (dimensions && dimensions.width * dimensions.height > 48_000_000)
    throw Error('原图超过48MP安全处理上限，请保留原图并在电脑处理；未裁切或放大。');
  const url = URL.createObjectURL(file);
  let source: ImageBitmap | HTMLImageElement | undefined;
  try {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      source = await image(url);
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
      ...(exif ? { capturedAt: exif.at, captureSource: 'exif' as const } : {}),
      outputWidth: width,
      outputHeight: height,
    };
    const logo = await fetch('/brand/source/chunmo-original.jpg').then((r) => {
      if (!r.ok) throw Error('原始Logo加载失败');
      return r.blob();
    });
    const logoData = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(logo);
    });
    async function encode() {
      actual.outputWidth = width;
      actual.outputHeight = height;
      const ctx = draw();
      const overlayUrl = URL.createObjectURL(
        new Blob([watermarkSvg(width, height, actual, logoData)], { type: 'image/svg+xml' }),
      );
      try {
        ctx.drawImage(await image(overlayUrl), 0, 0);
      } finally {
        URL.revokeObjectURL(overlayUrl);
      }
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error('设备内存不足，无法生成水印，请保留原图'))),
          'image/jpeg',
          0.95,
        ),
      );
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

    canvas.width = canvas.height = 0;
    return {
      blob,
      meta: actual,
      width,
      height,
      originalWidth: w,
      originalHeight: h,
      exifRaw: exif?.raw,
    };
  } finally {
    if (source && 'close' in source) source.close();
    URL.revokeObjectURL(url);
  }
}
