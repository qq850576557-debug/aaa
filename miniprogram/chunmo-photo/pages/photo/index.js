const { requireSession } = require('../../lib/session');
Page({
  data: { pending: 0, privacyVisible: false },
  onShow() {
    const app = requireSession();
    if (!app) return;
    this.setData({ pending: app.engine.stats().pending + app.engine.stats().failed });
  },
  camera() {
    wx.navigateTo({ url: '/pages/places/index' });
  },
  recover() {
    wx.navigateTo({ url: '/pages/results/index?recover=1' });
  },
});
