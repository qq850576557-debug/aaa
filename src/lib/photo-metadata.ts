import type { PhotoMeta } from './site-photo';
const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
/** Preserve the actual GPS and selection provenance in the exported JPEG, without changing pixels. */
export async function photoMetadata(blob: Blob, m: PhotoMeta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] !== 255 || bytes[1] !== 216) throw Error('水印输出不是JPEG，原始捕获文件已保留');
  const data = {
    captureMethod: m.captureMethod,
    placeName: m.placeName,
    placeSource: m.placeSource,
    location: m.location,
    placePoi: m.placePoi,
    capturedAt: m.capturedAt,
    actorName: m.actorName,
    coordinateSystem: 'WGS84',
    poiCoordinateSystem: 'GCJ02',
  };
  const packet = new TextEncoder().encode(
    'http://ns.adobe.com/xap/1.0/\0' +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:cm="https://chmsj.cn/photo/1.0/" cm:provenance="${xml(JSON.stringify(data))}"/></rdf:RDF></x:xmpmeta>`,
  );
  const length = packet.length + 2;
  if (length > 65535) throw Error('照片定位元数据过大，原始捕获文件已保留');
  return new Blob(
    [
      bytes.slice(0, 2),
      new Uint8Array([255, 225, length >> 8, length & 255]),
      packet,
      bytes.slice(2),
    ],
    { type: 'image/jpeg' },
  );
}
