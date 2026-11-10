import { watermarkLayout } from './photo-layout';
export { photoTime, watermarkLayout } from './photo-layout';
import { z } from 'zod';
export const PHOTO_CHUNK = 512 * 1024;
export const PHOTO_MAX = 50 * 1024 * 1024;
export const photoInput = z
  .object({
    requestId: z.uuid(),
    projectId: z.string().max(100),
    capturedAt: z.iso.datetime(),
    captureSource: z.enum([
      'exif',
      'camera-request',
      'file-selection',
      'live-camera',
      'native-camera',
    ]),
    placeToken: z.string().max(8000).optional(),
    originalName: z.string().max(240),
    originalSize: z.number().int().min(1).max(PHOTO_MAX),
    outputWidth: z.number().int().min(1).max(12000),
    outputHeight: z.number().int().min(1).max(12000),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100000),
        obtainedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PhotoInput = z.infer<typeof photoInput>;
export type PhotoMeta = PhotoInput & {
  placeName?: string;
  placeSource?: string;
  nearby?: boolean;
  legacyLocationUnverified?: boolean;
  associationVersion?: number;
  actorId: string;
  actorName: string;
  projectName: string;
  uploadedAt?: string;
  exifRaw?: string;
  originalWidth?: number;
  originalHeight?: number;
  complete?: boolean;
};
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export function watermarkSvg(width: number, height: number, m: PhotoMeta, logo: string) {
  const { scale, font, gap, pad, wrapped, boxW, boxH, x, y } = watermarkLayout(width, height, m);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${14 * scale}" fill="#152c23" fill-opacity=".78"/><image href="${logo}" x="${x + pad}" y="${y + pad - 5 * scale}" width="${34 * scale}" height="${34 * scale}" preserveAspectRatio="xMidYMid meet"/><text x="${x + pad + 47 * scale}" y="${y + pad + font}" fill="#fffdf1" font-family="sans-serif" font-size="${font}" font-weight="600">春茉设计</text>${wrapped.map((text, i) => `<text x="${x + pad}" y="${y + pad + gap * (i + 2)}" fill="#fffdf1" font-family="sans-serif" font-size="${font}">${esc(text)}</text>`).join('')}</svg>`;
}
