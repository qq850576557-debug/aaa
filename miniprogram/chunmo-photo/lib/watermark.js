function photoTime(at) {
  const d = new Date(Date.parse(at) + 8 * 3600000);
  return d.toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '.');
}
function layout(width, height, task) {
  const scale = Math.min(width / 1100, height / 800);
  const lines = [
    '工地定位：' + task.place.placeName,
    '拍摄时间：' + photoTime(task.capturedAt),
    '拍摄人员：' + task.actorName,
  ].flatMap((text) => {
    const chars = Array.from(text),
      a = [];
    for (let i = 0; i < chars.length; i += 26) a.push(chars.slice(i, i + 26).join(''));
    return a;
  });
  const font = 24 * scale,
    gap = 35 * scale,
    pad = 22 * scale;
  const boxW = Math.min(width - 32 * scale, 780 * scale),
    boxH = pad * 2 + 72 * scale + font + gap * (lines.length - 1);
  return {
    scale,
    font,
    gap,
    pad,
    lines,
    boxW,
    boxH,
    x: 16 * scale,
    y: height - boxH - 16 * scale,
    logoSize: 64 * scale,
    brandFont: 40 * scale,
    headerH: 72 * scale,
  };
}
function drawWatermark(ctx, logo, width, height, task) {
  const l = layout(width, height, task),
    { x, y, pad, logoSize } = l;
  ctx.save();
  ctx.fillStyle = 'rgba(21,44,35,0.55)';
  rounded(ctx, x, y, l.boxW, l.boxH, 14 * l.scale);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + pad + logoSize / 2, y + pad + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(logo, x + pad, y + pad, logoSize, logoSize);
  ctx.restore();
  ctx.fillStyle = '#fffdf1';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 ' + l.brandFont + 'px sans-serif';
  ctx.fillText(
    '春茉设计',
    x + pad + logoSize + 12 * l.scale,
    y + pad + logoSize / 2 + l.brandFont * 0.38,
  );
  ctx.font = l.font + 'px sans-serif';
  l.lines.forEach((line, i) =>
    ctx.fillText(line, x + pad, y + pad + l.headerH + l.font + l.gap * i),
  );
  ctx.restore();
  return l;
}
function rounded(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
// On a decode-only copy, set EXIF orientation to 1 before drawing. This prevents
// vendor Canvas decoders auto-rotating and us rotating the same image again.
// The original captured file is never modified.
function neutralizeExif(buffer) {
  const d = new DataView(buffer),
    len = d.byteLength;
  if (len < 4 || d.getUint16(0) !== 0xffd8) return { jpeg: false, orientation: 1 };
  let offset = 2,
    orientation = 1;
  while (offset + 4 <= len) {
    if (d.getUint8(offset) !== 0xff) break;
    const tag = d.getUint8(offset + 1);
    if (tag === 0xda || tag === 0xd9) break;
    const size = d.getUint16(offset + 2);
    if (size < 2 || offset + 2 + size > len) break;
    if (
      tag === 0xe1 &&
      size >= 16 &&
      d.getUint32(offset + 4) === 0x45786966 &&
      d.getUint16(offset + 8) === 0
    ) {
      const t = offset + 10,
        little = d.getUint16(t) === 0x4949;
      if (!(little || d.getUint16(t) === 0x4d4d) || d.getUint16(t + 2, little) !== 42) break;
      const ifd = t + d.getUint32(t + 4, little),
        end = offset + size + 2;
      if (ifd + 2 > end) break;
      const count = d.getUint16(ifd, little);
      for (let i = 0; i < count && ifd + 2 + (i + 1) * 12 <= end; i++) {
        const p = ifd + 2 + i * 12;
        if (
          d.getUint16(p, little) === 0x0112 &&
          d.getUint16(p + 2, little) === 3 &&
          d.getUint32(p + 4, little) === 1
        ) {
          orientation = d.getUint16(p + 8, little);
          if (orientation < 1 || orientation > 8) throw Error('照片方向标记无效，原图已保留');
          d.setUint16(p + 8, 1, little);
        }
      }
    }
    offset += size + 2;
  }
  return { jpeg: true, orientation };
}
function orientationTransform(o, w, h) {
  return {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, w, 0],
    3: [-1, 0, 0, -1, w, h],
    4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, h, 0],
    7: [0, -1, -1, 0, h, w],
    8: [0, -1, 1, 0, 0, w],
  }[o];
}
module.exports = { photoTime, layout, drawWatermark, neutralizeExif, orientationTransform };
