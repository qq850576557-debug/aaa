const { message, call } = require('../../lib/platform');
Page({
  data: { login: '', busy: false, error: '', privacyVisible: false },
  async onLoad() {
    const app = getApp();
    this.setData({ login: app.pendingLogin || '' });
    // Resume only an existing in-memory session; do not persist employee cookies.
    if (app.api?.identity && app.engine) {
      try {
        await app.api.restore();
        await call('switchTab', { url: '/pages/workbench/index' });
      } catch (e) {
        this.setData({ error: message(e) });
      }
    }
  },
  accountInput(e) {
    this.setData({ login: e.detail.value.replace(/[\r\n]/g, '') });
  },
  privacyContract() {
    wx.openPrivacyContract({
      fail: () => this.setData({ error: '隐私指引尚未配置，请联系负责人' }),
    });
  },
  async next() {
    if (this.data.busy) return;
    const login = this.data.login.trim();
    if (!login) return this.setData({ error: '请填写员工账号' });
    this.setData({ busy: true, error: '' });
    // Destroy the account page before creating any secure password input.
    // Never pass passwords or account names through navigation URLs/logs.
    getApp().pendingLogin = login;
    if (wx.hideKeyboard) wx.hideKeyboard({ fail() {} });
    try {
      await call('redirectTo', { url: '/pages/password/index' });
    } catch (error) {
      this.setData({ error: message(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
});
