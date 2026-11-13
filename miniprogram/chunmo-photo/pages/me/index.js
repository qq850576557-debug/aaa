const { requireSession } = require('../../lib/session');
const { client } = require('../../lib/workbench-client');
const { call, message } = require('../../lib/platform');
Page({
  data: { name: '', pending: 0, error: '', privacyVisible: false },
  onShow() {
    this.app = requireSession();
    if (!this.app) return;
    try {
      const c = client(this.app);
      this.setData({
        name: this.app.api.identity.name,
        pending: c.pending.length,
        archive: c.archive.length,
      });
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
  photos() {
    wx.navigateTo({ url: '/pages/results/index?recover=1' });
  },
  async exportDrafts() {
    try {
      const c = client(this.app);
      await call('setClipboardData', {
        data: JSON.stringify({ pending: c.pending, drafts: c.drafts, archive: c.archive }, null, 2),
      });
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
  async logout() {
    const a = await call('showModal', {
      title: '退出登录',
      content: '本机待同步记录、草稿和照片会保留在原账号下，重新登录原账号后可继续处理。',
    });
    if (!a.confirm) return;
    try {
      await this.app.api.logout();
    } catch {}
    if (this.app.engine) this.app.engine.active = false;
    this.app.workbench = null;
    wx.reLaunch({ url: '/pages/login/index' });
  },
});
