function startPreview(page) {
  const version = wx.getAccountInfoSync?.().miniProgram?.envVersion;
  if (version !== 'develop' && version !== 'trial') {
    wx.reLaunch({ url: '/pages/login/index' });
    return;
  }
  const statusTop = wx.getWindowInfo?.().statusBarHeight ?? 24;
  page.setData({ ready: true, statusTop });
}

module.exports = { startPreview };
