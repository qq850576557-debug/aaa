function call(name, options = {}) {
  return new Promise((resolve, reject) => {
    // A missing OS callback must not freeze the queue forever. A timeout for
    // album saving is UNKNOWN, never success, and requires user verification.
    const deadline =
      name === 'saveImageToPhotosAlbum'
        ? setTimeout(() => reject(Error('相册保存未返回结果，请先核对系统相册')), 60000)
        : null;
    wx[name]({
      ...options,
      success: (value) => {
        clearTimeout(deadline);
        resolve(value);
      },
      fail: (error) => {
        clearTimeout(deadline);
        reject(error);
      },
    });
  });
}
function message(error) {
  const text = String((error && (error.message || error.errMsg)) || '操作未完成，请重试');
  if (/quota|space|storage|limit exceeded|空间/i.test(text))
    return '本机可用空间不足，照片已保留；请释放其他文件空间后重试';
  if (/auth deny|authorize:fail|permission|privacy/i.test(text))
    return '权限未获得，请在右上角设置中检查定位、相机及相册权限';
  return text.slice(0, 200);
}
function showError(error) {
  return call('showModal', { title: '操作未完成', content: message(error), showCancel: false });
}
function privacy() {
  if (!wx.requirePrivacyAuthorize) return Promise.reject(Error('请升级微信后使用拍照功能'));
  return call('requirePrivacyAuthorize');
}
function safeTop() {
  const w = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const menu = wx.getMenuButtonBoundingClientRect();
  return { top: menu.bottom + 12, windowWidth: w.windowWidth, windowHeight: w.windowHeight };
}
module.exports = { call, message, showError, privacy, safeTop };
