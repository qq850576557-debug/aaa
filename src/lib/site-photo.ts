import { z } from 'zod';
export const PHOTO_CHUNK = 512 * 1024;
export const PHOTO_MAX = 50 * 1024 * 1024;
export const photoInput = z
  .object({
    requestId: z.uuid(),
    projectId: z.string().min(1).max(100),
    capturedAt: z.iso.datetime(),
    captureSource: z.enum(['exif', 'camera-request', 'file-selection']),
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
  actorId: string;
  actorName: string;
  projectName: string;
  uploadedAt?: string;
  exifRaw?: string;
  originalWidth?: number;
  originalHeight?: number;
  complete?: boolean;
};
export function photoTime(at: string) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(at))
    .replaceAll('-', '.');
}
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export function watermarkSvg(width: number, height: number, m: PhotoMeta, logo: string) {
  const scale = Math.min(width / 1100, height / 800),
    font = 24 * scale,
    gap = 35 * scale,
    pad = 22 * scale;
  const maxChars = 26;
  const lines = [m.projectName];
  const projectLines = [];
  for (let i = 0; i < lines[0].length; i += maxChars)
    projectLines.push(lines[0].slice(i, i + maxChars));
  const details = [
    ...projectLines,
    photoTime(m.capturedAt) + (m.captureSource === 'file-selection' ? '（选图时间）' : ''),
    `拍摄人：${m.actorName}`,
    m.location
      ? `定位：${m.location.latitude.toFixed(5)}, ${m.location.longitude.toFixed(5)}`
      : '定位：未获取',
    ...(m.location ? [`GPS精度：约±${Math.round(m.location.accuracy)}米`] : []),
  ];
  const wrapped = details.flatMap((text) => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
    return out;
  });
  const boxW = Math.min(width - 32 * scale, 780 * scale),
    boxH = pad * 2 + gap * (wrapped.length + 1),
    x = 16 * scale,
    y = height - boxH - 16 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${14 * scale}" fill="#152c23" fill-opacity=".78"/><image href="${logo}" x="${x + pad}" y="${y + pad - 5 * scale}" width="${34 * scale}" height="${34 * scale}" preserveAspectRatio="xMidYMid meet"/><text x="${x + pad + 47 * scale}" y="${y + pad + font}" fill="#fffdf1" font-family="sans-serif" font-size="${font}" font-weight="600">春茉设计</text>${wrapped.map((text, i) => `<text x="${x + pad}" y="${y + pad + gap * (i + 2)}" fill="${i < projectLines.length ? '#e2efd7' : '#fffdf1'}" font-family="sans-serif" font-size="${font}">${esc(text)}</text>`).join('')}</svg>`;
}
