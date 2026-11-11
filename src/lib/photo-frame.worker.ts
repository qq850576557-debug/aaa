let canvas: OffscreenCanvas | undefined;
self.onmessage = async ({ data }) => {
  if (!data.bitmap) return;
  const { bitmap, id } = data;
  try {
    canvas ||= new OffscreenCanvas(bitmap.width, bitmap.height);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('离屏捕获不可用');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const at = performance.now();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.98 });
    self.postMessage({ id, blob, encodeMs: performance.now() - at });
  } catch (e) {
    bitmap.close();
    self.postMessage({ id, error: String(e) });
  }
};
