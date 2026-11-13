const fs = require('node:fs/promises');
const crypto = require('node:crypto');
function adapter() {
  const impl = {
    access: (o) => fs.access(o.path),
    mkdir: (o) => fs.mkdir(o.dirPath, { recursive: o.recursive }),
    readdir: async (o) => ({ files: await fs.readdir(o.dirPath) }),
    readFile: async (o) => ({ data: await fs.readFile(o.filePath, o.encoding) }),
    writeFile: (o) => fs.writeFile(o.filePath, o.data, o.encoding),
    rename: (o) => fs.rename(o.oldPath, o.newPath),
    copyFile: (o) => fs.copyFile(o.srcPath, o.destPath),
    unlink: (o) => fs.unlink(o.filePath),
    getFileInfo: async (o) => {
      const data = await fs.readFile(o.filePath);
      return {
        size: data.length,
        digest: crypto.createHash(o.digestAlgorithm).update(data).digest('hex'),
      };
    },
  };
  const api = { fail: null };
  Object.keys(impl).forEach((key) => {
    api[key] = (o) => {
      if (api.fail && api.fail(key, o))
        return queueMicrotask(() => o.fail(Error('injected disk full')));
      impl[key](o).then((value) => o.success(value || {}), o.fail);
    };
  });
  return api;
}
module.exports = { adapter };
