const avatar = require('../../owner-login/avatar');
const { avatarEditor } = require('../../owner-login/profile-avatar');
const { origin } = require('../../config');
const unified = require('../../lib/unified-login');
const { requireSession } = require('../../lib/session');
const { client } = require('../../lib/workbench-client');
const { call, message } = require('../../lib/platform');
Page({
  ...avatarEditor('profile', async function (path) {
    const epoch = this.avatarEpoch;
    const key = this.avatarKey;
    const { savedFilePath } = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().saveFile({ tempFilePath: path, success: resolve, fail: reject });
    });
    if (epoch !== this.avatarEpoch || key !== this.avatarKey) return;
    const previous = wx.getStorageSync(key);
    wx.setStorageSync(key, savedFilePath);
    if (previous && previous !== savedFilePath)
      wx.getFileSystemManager().removeSavedFile({ filePath: previous, fail() {} });
    this.setData({ 'profile.avatar': savedFilePath });
  }),
  data: {
    profile: null,
    subtitle: '',
    pending: 0,
    error: '',
    privacyVisible: false,
    maxZoom: avatar.MAX_ZOOM,
  },
  onShow() {
    this.app = requireSession();
    if (!this.app) return;
    try {
      const c = client(this.app);
      const api = this.app.api;
      const identity = api.identity;
      const key =
        'chunmo.employee.avatar.v1:' + JSON.stringify([origin, identity.workspaceId, identity.id]);
      this.avatarKey = key;
      this.setData({
        profile: { name: identity.name, avatar: wx.getStorageSync(key) || '' },
        subtitle: '',
        canSwitch: unified.canSwitch(),
        pending: c.pending.length,
        archive: c.archive.length,
      });
      void api
        .personalProfile?.()
        .then((value) => {
          if (!value || key !== this.avatarKey || !this.data.profile) return;
          this.setData({
            'profile.name': value.name || identity.name,
            subtitle: [value.department, value.jobTitle].filter(Boolean).join(' · '),
          });
        })
        .catch(() => {});
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
  onUnload() {
    this.avatarKey = undefined;
    this.releaseAvatar();
  },
  switchIdentity() {
    wx.reLaunch({ url: unified.entry + '?choose=1' });
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
    wx.reLaunch({ url: unified.entry });
  },
});
