// Dedicated USER_DATA_PATH subtree. Never touches PWA/Android/Harmony files.
// Immutable numbered journal revisions survive incomplete writes; no overwrite of
// the previous good metadata and no automatic deletion of any photo.
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
class PhotoStore {
  constructor(fs, root, identity) {
    if (!ID.test(identity.id) || !ID.test(identity.workspaceId)) throw Error('账号标识无效');
    this.fs = fs;
    this.identity = identity;
    this.root = root + '/chunmo-photo-v1/' + identity.workspaceId + '__' + identity.id;
    this.tasks = new Map();
    this.highestRevision = new Map();
    this.serial = Promise.resolve();
    this.warnings = [];
  }
  io(name, args) {
    return new Promise((resolve, reject) =>
      this.fs[name]({ ...args, success: resolve, fail: reject }),
    );
  }
  async exists(path) {
    try {
      await this.io('access', { path });
      return true;
    } catch {
      return false;
    }
  }
  async init() {
    await this.io('mkdir', { dirPath: this.root, recursive: true });
    const { files } = await this.io('readdir', { dirPath: this.root });
    for (const id of files.filter((id) => ID.test(id))) {
      const dir = this.root + '/' + id;
      let revisions;
      try {
        revisions = (await this.io('readdir', { dirPath: dir })).files
          .filter((f) => /^r-\d{8,12}\.json$/.test(f))
          .sort((a, b) => Number(b.slice(2, -5)) - Number(a.slice(2, -5)));
      } catch {
        continue;
      }
      this.highestRevision.set(id, revisions.length ? Number(revisions[0].slice(2, -5)) : 0);
      let found = false,
        recovered = null,
        damaged = false;
      for (const filename of revisions) {
        try {
          const { data } = await this.io('readFile', {
            filePath: dir + '/' + filename,
            encoding: 'utf8',
          });
          const task = JSON.parse(data);
          if (
            task.id !== id ||
            task.actorId !== this.identity.id ||
            task.workspaceId !== this.identity.workspaceId ||
            task.revision !== Number(filename.slice(2, -5))
          )
            throw Error('journal');
          task.dir = dir;
          this.tasks.set(id, task);
          found = true;
          recovered = task;
          break;
        } catch {
          damaged = true; /* Try previous metadata but never infer an OS save outcome. */
        }
      }
      if (!found) this.warnings.push('有一份本机照片记录无法读取，文件已保留，请联系负责人');
      // Recovery-write failures must not make us fall back from an OS saving
      // revision to an older ready revision and accidentally duplicate a photo.
      if (recovered) {
        if (recovered.stage === 'saving' || damaged)
          await this.update(id, {
            stage: 'unknown',
            error: '上次相册保存结果未确认，请先核对系统相册',
          });
        if (!damaged && recovered.stage === 'capturing' && (await this.exists(dir + '/raw'))) {
          const raw = await this.io('getFileInfo', {
            filePath: dir + '/raw',
            digestAlgorithm: 'md5',
          });
          if (raw.size > 0)
            await this.update(id, { stage: 'raw', rawBytes: raw.size, rawDigest: raw.digest });
        }
      }
    }
    return this.list();
  }
  list() {
    return Array.from(this.tasks.values()).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  update(id, patch) {
    const write = this.serial.then(async () => {
      const old = this.tasks.get(id);
      if (!old) throw Error('照片记录不存在');
      // Callers cannot change the owner, paths, capture identity or ID.
      const {
        stage,
        error,
        outputWidth,
        outputHeight,
        rawWidth,
        rawHeight,
        rawBytes,
        rawDigest,
        outputBytes,
        outputDigest,
        albumConfirmedAt,
        deleted,
        thumbnailReady,
      } = patch;
      const changes = {
        stage,
        error,
        outputWidth,
        outputHeight,
        rawWidth,
        rawHeight,
        rawBytes,
        rawDigest,
        outputBytes,
        outputDigest,
        albumConfirmedAt,
        deleted,
        thumbnailReady,
      };
      const task = { ...old };
      Object.keys(changes).forEach((key) => {
        if (changes[key] !== undefined) task[key] = changes[key];
      });
      task.revision = Math.max(old.revision, this.highestRevision.get(id) || 0) + 1;
      await this.journal(task);
      this.tasks.set(id, task);
      return task;
    });
    this.serial = write.catch(() => {});
    return write;
  }
  async journal(task) {
    const name = task.dir + '/r-' + String(task.revision).padStart(8, '0') + '.json';
    // A failed revision may have been left behind. Use a unique part file and
    // rename only a fully written, parsed document; the old revisions stay intact.
    const part = name + '.' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.part';
    await this.io('writeFile', { filePath: part, data: JSON.stringify(task), encoding: 'utf8' });
    const check = await this.io('readFile', { filePath: part, encoding: 'utf8' });
    if (JSON.parse(check.data).revision !== task.revision) throw Error('本机照片记录校验失败');
    await this.io('rename', { oldPath: part, newPath: name });
    this.highestRevision.set(task.id, task.revision);
  }
  async reserve(place, capturedAt) {
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    const dir = this.root + '/' + id;
    await this.io('mkdir', { dirPath: dir, recursive: true });
    const task = {
      version: 1,
      id,
      dir,
      revision: 1,
      stage: 'capturing',
      capturedAt,
      actorId: this.identity.id,
      workspaceId: this.identity.workspaceId,
      actorName: this.identity.name,
      place: JSON.parse(JSON.stringify(place)),
      error: '',
    };
    await this.journal(task);
    this.tasks.set(id, task);
    return task;
  }
  async copyVerified(source, destination) {
    const sourceInfo = await this.io('getFileInfo', { filePath: source, digestAlgorithm: 'md5' });
    if (sourceInfo.size <= 0) throw Error('照片文件为空');
    const part = destination + '.part';
    await this.io('copyFile', { srcPath: source, destPath: part });
    const saved = await this.io('getFileInfo', { filePath: part, digestAlgorithm: 'md5' });
    if (saved.size !== sourceInfo.size || saved.digest !== sourceInfo.digest)
      throw Error('本机照片写入校验失败');
    await this.io('rename', { oldPath: part, newPath: destination });
    return saved;
  }
  async persistRaw(id, temporary) {
    const task = this.tasks.get(id);
    const info = await this.copyVerified(temporary, task.dir + '/raw');
    return this.update(id, {
      stage: 'raw',
      error: '',
      rawBytes: info.size,
      rawDigest: info.digest,
    });
  }
  async persistOutput(id, result) {
    const task = this.tasks.get(id);
    const info = await this.copyVerified(result.path, task.dir + '/marked.jpg');
    // Thumbnail is expendable. A failure must never hide the valid full photo.
    let thumbnailReady = false;
    if (result.thumbnail)
      try {
        await this.copyVerified(result.thumbnail, task.dir + '/thumb.jpg');
        thumbnailReady = true;
      } catch {
        /* optional */
      }
    return this.update(id, {
      stage: 'ready',
      error: '',
      outputWidth: result.width,
      outputHeight: result.height,
      rawWidth: result.rawWidth,
      rawHeight: result.rawHeight,
      outputBytes: info.size,
      outputDigest: info.digest,
      thumbnailReady,
    });
  }
  async remove(id) {
    const task = this.tasks.get(id);
    if (!task || task.stage === 'saving') throw Error('照片正在保存，请稍后再删除');
    // Explicit confirmed ID only; tombstone before removing files. No recursive
    // folder deletes or sweeping another account/unknown legacy files.
    await this.update(id, { deleted: true });
    for (const filename of [
      'raw',
      'marked.jpg',
      'thumb.jpg',
      'decode.jpg',
      'raw.part',
      'marked.jpg.part',
    ]) {
      const path = task.dir + '/' + filename;
      if (await this.exists(path)) await this.io('unlink', { filePath: path });
    }
  }
}
module.exports = { PhotoStore };
