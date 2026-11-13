// 16:9 landscape / 9:16 portrait preview, fitted between navigation and controls.
// This affects the viewfinder only: still photos retain all original pixels.
function viewport(width, height, safeTop) {
  const landscape = width > height;
  const top = landscape ? safeTop : safeTop + 64;
  const availableW = landscape ? width - 124 : width;
  const availableH = Math.max(1, height - top - (landscape ? 16 : 145));
  const ratio = landscape ? 16 / 9 : 9 / 16;
  const w = Math.min(availableW, availableH * ratio);
  const h = w / ratio;
  return { left: (availableW - w) / 2, top: top + (availableH - h) / 2, width: w, height: h };
}
module.exports = { viewport };
