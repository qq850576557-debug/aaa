const avatar = require('../../owner-login/avatar');
const { avatarEditor } = require('../../owner-login/profile-avatar');
const unified = require('../../lib/unified-login');
const { requireSession } = require('../../lib/session');
const { client } = require('../../lib/workbench-client');
const { call, message } = require('../../lib/platform');
Page({
  ...avatarEditor('profile', async function (path) {
    const epoch = this.avatarEpoch;
    const key = this.avatarKey;
    const image = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'base64',
        success: ({ data }) => resolve(data),
        fail: reject,
      });
    });
    await this.app.api.personalAvatar('data:image/jpeg;base64,' + image);
    if (epoch === this.avatarEpoch && key === this.avatarKey) {
      this.avatarFetch = (this.avatarFetch || 0) + 1;
      this.showEmployeeAvatar(path);
    }
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
      const key = JSON.stringify([identity.workspaceId, identity.id]);
      const previousAvatar = this.avatarKey === key ? this.data.profile?.avatar : '';
      const fetch = (this.avatarFetch = (this.avatarFetch || 0) + 1);
      this.avatarKey = key;
      this.setData({
        profile: { name: identity.name, avatar: previousAvatar || '' },
        subtitle: '',
        canSwitch: unified.canSwitch(),
        pending: c.pending.length,
        archive: c.archive.length,
      });
      void api
        .personalAvatar()
        .then(async (bytes) => {
          if (fetch !== this.avatarFetch || key !== this.avatarKey) return;
          if (!bytes) return this.showEmployeeAvatar('');
          const path =
            wx.env.USER_DATA_PATH +
            '/employee-avatar-' +
            Date.now() +
            '-' +
            Math.random().toString(36).slice(2);
          const fs = wx.getFileSystemManager();
          await new Promise((resolve, reject) => {
            fs.writeFile({ filePath: path, data: bytes, success: resolve, fail: reject });
          });
          if (fetch === this.avatarFetch && key === this.avatarKey)
            this.showEmployeeAvatar(path, path);
          else fs.unlink({ filePath: path, fail() {} });
        })
        .catch(() => {});
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
  showEmployeeAvatar(path, downloaded) {
    const previous = this.downloadedAvatar;
    this.downloadedAvatar = downloaded;
    if (previous) wx.getFileSystemManager().unlink({ filePath: previous, fail() {} });
    if (this.data.profile) this.setData({ 'profile.avatar': path });
  },
  avatarFailed(event) {
    if (event.target.dataset.avatar === this.data.profile?.avatar) this.showEmployeeAvatar('');
  },
  onUnload() {
    this.avatarKey = undefined;
    this.showEmployeeAvatar('');
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
