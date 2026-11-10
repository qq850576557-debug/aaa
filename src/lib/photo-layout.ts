import type { PhotoMeta } from './site-photo';

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
export function watermarkLayout(width: number, height: number, m: PhotoMeta) {
  const scale = Math.min(width / 1100, height / 800),
    font = 24 * scale,
    gap = 35 * scale,
    pad = 22 * scale;
  const maxChars = 26;
  const details = m.placeName
    ? [
        `工地定位：${m.nearby ? '附近：' : ''}${m.placeName}`,
        `拍摄时间：${photoTime(m.capturedAt)}`,
        `拍摄人员：${m.actorName}`,
      ]
    : [
        ...(m.legacyLocationUnverified ? ['历史照片 · 未核实现场定位'] : []),
        m.projectName,
        photoTime(m.capturedAt) + (m.captureSource === 'file-selection' ? '（选图时间）' : ''),
        `拍摄人：${m.actorName}`,
        '定位：未获取',
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
  return { scale, font, gap, pad, wrapped, boxW, boxH, x, y };
}
