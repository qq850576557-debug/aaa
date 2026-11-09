/** Header-only allocation guard: reject image bombs before browser bitmap decoding. */
export function encodedDimensions(b: Uint8Array): { width: number; height: number } | null {
  try {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getUint32(0) === 0x89504e47) return { width: v.getUint32(16), height: v.getUint32(20) };
    if (b[0] === 255 && b[1] === 216) {
      for (let p = 2; p + 8 < b.length;) {
        if (b[p] !== 255) return null;
        const marker = b[p + 1],
          len = v.getUint16(p + 2);
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
          return { width: v.getUint16(p + 7), height: v.getUint16(p + 5) };
        if (len < 2) return null;
        p += len + 2;
      }
      return null;
    }
    if (String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
      const kind = String.fromCharCode(...b.subarray(12, 16));
      if (kind === 'VP8X')
        return {
          width: 1 + b[24] + b[25] * 256 + b[26] * 65536,
          height: 1 + b[27] + b[28] * 256 + b[29] * 65536,
        };
      if (kind === 'VP8L')
        return {
          width: 1 + (b[21] | ((b[22] & 63) << 8)),
          height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 15) << 10)),
        };
      if (kind === 'VP8 ')
        return { width: v.getUint16(26, true) & 16383, height: v.getUint16(28, true) & 16383 };
    }
  } catch {
    /* Unknown formats are left to the platform decoder. */
  }
  return null;
}
