/** Read only JPEG EXIF DateTimeOriginal + optional UTC offset. Never modify source bytes. */
export function exifCapture(bytes: Uint8Array): { at: string; raw: string } | null {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let base = -1;
    for (let p = 2; p + 10 < bytes.length;) {
      if (v.getUint8(p) !== 255) break;
      const marker = v.getUint8(p + 1),
        len = v.getUint16(p + 2);
      if (len < 2 || p + 2 + len > bytes.length) break;
      if (marker === 225 && String.fromCharCode(...bytes.subarray(p + 4, p + 10)) === 'Exif\0\0') {
        base = p + 10;
        break;
      }
      p += 2 + len;
    }
    if (base < 0) return null;
    const little = v.getUint16(base) === 0x4949;
    if (v.getUint16(base + 2, little) !== 42) return null;
    const text = (p: number, count: number) => {
      if (count < 1 || count > 64) throw Error();
      const q = count <= 4 ? p + 8 : base + v.getUint32(p + 8, little);
      return String.fromCharCode(...bytes.subarray(q, q + count)).replace(/\0.*$/, '');
    };
    let date = '',
      offset = '';
    const read = (pos: number, depth: number) => {
      if (depth > 1 || pos < base || pos + 2 > bytes.length) return;
      const n = v.getUint16(pos, little);
      if (n > 512) return;
      for (let i = 0; i < n; i++) {
        const p = pos + 2 + i * 12,
          tag = v.getUint16(p, little),
          count = v.getUint32(p + 4, little);
        if (tag === 0x8769) read(base + v.getUint32(p + 8, little), depth + 1);
        if (tag === 0x9003) date = text(p, count);
        if (tag === 0x9011) offset = text(p, count);
      }
    };
    read(base + v.getUint32(base + 4, little), 0);
    if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) return null;
    const raw = date + (offset ? ' ' + offset : ' (设备本地时间，按北京时间解释)');
    const at =
      date.slice(0, 10).replaceAll(':', '-') +
      'T' +
      date.slice(11) +
      (/^[+-]\d\d:\d\d$/.test(offset) ? offset : '+08:00');
    return Number.isFinite(Date.parse(at)) ? { at: new Date(at).toISOString(), raw } : null;
  } catch {
    return null;
  }
}
