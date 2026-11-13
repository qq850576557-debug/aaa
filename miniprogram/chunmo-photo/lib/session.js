const { PhotoStore } = require('./store');
const { PhotoQueue } = require('./queue');
const { call } = require('./platform');
async function enter(identity) {
  const app = getApp();
  if (app.engine) {
    app.engine.active = false;
    if (app.engine.running) await app.engine.running;
  }
  app.engine = null;
  app.store = null;
  app.place = null;
  app.captureIds = [];
  const store = new PhotoStore(wx.getFileSystemManager(), wx.env.USER_DATA_PATH, identity);
  await store.init();
  app.store = store;
  app.engine = new PhotoQueue(store, (filePath) => call('saveImageToPhotosAlbum', { filePath }));
  app.place = null;
  app.captureIds = [];
  return app.engine;
}
function requireSession() {
  const app = getApp();
  const identity = app.api.identity,
    owner = app.engine && app.engine.store.identity;
  if (identity && owner && identity.id === owner.id && identity.workspaceId === owner.workspaceId)
    return app;
  wx.reLaunch({ url: '/pages/login/index' });
  return null;
}
async function enableAlbum(engine, activate = true) {
  const setting = await call('getSetting');
  if (setting.authSetting['scope.writePhotosAlbum'] === false) {
    engine.autoSave = false;
    throw Error('相册权限已关闭，请点击“权限设置”开启，照片仍保留在本机');
  }
  await call('authorize', { scope: 'scope.writePhotosAlbum' });
  engine.autoSave = activate;
}
module.exports = { enter, requireSession, enableAlbum };
