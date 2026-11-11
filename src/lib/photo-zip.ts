/** ZIP32 STORE: JPEGs are already compressed. Sequential reads and streaming writes avoid holding the batch in RAM. */
export type ZipItem = { id: string; name: string; size: number; at: string };
export type ZipArchive = {
  file: File;
  ids: string[];
  cleanup: () => Promise<void>;
  storage: 'opfs' | 'memory';
};
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function header(size: number) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return { bytes, view };
}
function dos(at: string) {
  const d = new Date(at);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
export async function photoZip(
  items: ZipItem[],
  read: (id: string) => Promise<ArrayBuffer>,
  name: string,
  scope: string,
  progress: (n: number, total: number) => void,
): Promise<ZipArchive> {
  if (!items.length) throw Error('没有可打包的水印照片');
  if (items.length > 65535 || items.reduce((n, i) => n + i.size + 1024, 0) >= 0xffffffff)
    throw Error('本次照片超过ZIP32限制，请分批导出；照片未删除');
  let writer: FileSystemWritableFileStream | undefined,
    folder: FileSystemDirectoryHandle | undefined,
    path = '';
  try {
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope))),
      )
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      folder = await root.getDirectoryHandle('chunmo-zip-' + hash, { create: true });
      path = crypto.randomUUID() + '.zip';
      const h = await folder.getFileHandle(path, { create: true });
      writer = await h.createWritable();
    }
  } catch {
    if (folder && path) await folder.removeEntry(path).catch(() => {});
    folder = undefined;
    writer = undefined;
  }
  const budget = 64 * 1024 * 1024;
  if (!writer && items.reduce((n, i) => n + i.size + 1024, 0) > budget)
    throw Error('当前浏览器不支持大文件流式打包，请选择分批ZIP（每批不超过64MiB）；所有照片仍保留');
  const parts: BlobPart[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  const write = async (data: Uint8Array) => {
    if (writer) await writer.write(data as Uint8Array<ArrayBuffer>);
    else parts.push(new Blob([data as Uint8Array<ArrayBuffer>]));
    offset += data.byteLength;
  };
  const cleanup = async () => {
    if (folder && path) await folder.removeEntry(path).catch(() => {});
  };
  try {
    for (let index = 0; index < items.length; index++) {
      const item = items[index],
        bytes = new Uint8Array(await read(item.id));
      if (bytes.length !== item.size || bytes[0] !== 255 || bytes[1] !== 216)
        throw Error('照片文件缺失或JPEG内容异常，打包已停止，原资料保留');
      const fileName = new TextEncoder().encode(item.name.replace(/[\/\\\u0000]/g, '_'));
      if (fileName.length > 65535) throw Error('照片文件名过长');
      const date = dos(item.at),
        start = offset,
        local = header(30);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, 20, true);
      local.view.setUint16(6, 0x808, true);
      local.view.setUint16(10, date.time, true);
      local.view.setUint16(12, date.date, true);
      local.view.setUint16(26, fileName.length, true);
      await write(local.bytes);
      await write(fileName);
      let crc = 0xffffffff;
      for (let p = 0; p < bytes.length; p += 1024 * 1024) {
        const chunk = bytes.subarray(p, Math.min(bytes.length, p + 1024 * 1024));
        for (const b of chunk) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
        await write(chunk);
        await new Promise((r) => setTimeout(r, 0));
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const end = header(16);
      end.view.setUint32(0, 0x08074b50, true);
      end.view.setUint32(4, crc, true);
      end.view.setUint32(8, bytes.length, true);
      end.view.setUint32(12, bytes.length, true);
      await write(end.bytes);
      const c = header(46 + fileName.length);
      c.view.setUint32(0, 0x02014b50, true);
      c.view.setUint16(4, 20, true);
      c.view.setUint16(6, 20, true);
      c.view.setUint16(8, 0x808, true);
      c.view.setUint16(12, date.time, true);
      c.view.setUint16(14, date.date, true);
      c.view.setUint32(16, crc, true);
      c.view.setUint32(20, bytes.length, true);
      c.view.setUint32(24, bytes.length, true);
      c.view.setUint16(28, fileName.length, true);
      c.view.setUint32(42, start, true);
      c.bytes.set(fileName, 46);
      central.push(c.bytes);
      progress(index + 1, items.length);
    }
    const centralAt = offset;
    for (const c of central) await write(c);
    const centralSize = offset - centralAt,
      e = header(22);
    e.view.setUint32(0, 0x06054b50, true);
    e.view.setUint16(8, items.length, true);
    e.view.setUint16(10, items.length, true);
    e.view.setUint32(12, centralSize, true);
    e.view.setUint32(16, centralAt, true);
    await write(e.bytes);
    if (writer) {
      await writer.close();
      const file = await (await folder!.getFileHandle(path)).getFile();
      return {
        file: new File([file], name, { type: 'application/zip' }),
        ids: items.map((i) => i.id),
        cleanup,
        storage: 'opfs',
      };
    }
    return {
      file: new File(parts, name, { type: 'application/zip' }),
      ids: items.map((i) => i.id),
      cleanup: async () => {},
      storage: 'memory',
    };
  } catch (e) {
    await writer?.abort().catch(() => {});
    await cleanup();
    throw e;
  }
}
