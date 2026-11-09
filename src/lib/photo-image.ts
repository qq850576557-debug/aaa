/** Safari-safe: keep image bytes inside <img>; never navigate or download a blob: URL. */
export async function imageBlob(value: unknown, mime = 'image/jpeg'): Promise<Blob> {
  if (value instanceof ArrayBuffer) return new Blob([value], { type: mime });
  if (ArrayBuffer.isView(value))
    return new Blob(
      [new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer],
      { type: mime },
    );
  if (value && typeof (value as Blob).arrayBuffer === 'function') {
    const b = value as Blob;
    return new Blob([await b.arrayBuffer()], { type: b.type || mime });
  }
  throw Error('本地照片内容暂时无法读取；请保留网站数据，重试或恢复云端副本');
}
export async function imageDataUrl(value: unknown, mime = 'image/jpeg') {
  let b = await imageBlob(value, mime);
  const header = new Uint8Array(await b.slice(0, 16).arrayBuffer());
  const detected =
    header[0] === 255 && header[1] === 216
      ? 'image/jpeg'
      : header[0] === 137 && header[1] === 80
        ? 'image/png'
        : String.fromCharCode(...header.subarray(8, 12)) === 'WEBP'
          ? 'image/webp'
          : null;
  if (detected && detected !== b.type) b = new Blob([b], { type: detected });
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(Error('照片读取失败，请保留原记录'));
    r.readAsDataURL(b);
  });
}
export async function sharePhoto(blob: Blob, name: string): Promise<'shared' | 'preview'> {
  const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: '春茉设计' });
    return 'shared';
  }
  return 'preview';
}
