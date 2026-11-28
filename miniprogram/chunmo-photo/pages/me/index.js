const avatar = require('../../owner-login/avatar');
const { avatarEditor } = require('../../owner-login/profile-avatar');
const unified = require('../../lib/unified-login');
const { requireSession, clearEmployeeViews } = require('../../lib/session');
const { client } = require('../../lib/workbench-client');
const { setChanged } = require('../../lib/page-data');
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
      this.avatarBytes = null;
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
    const app = requireSession();
    if (!app) return this.clearProfile();
    this.app = app;
    try {
      const c = client(app);
      const identity = app.api.identity;
      const key = JSON.stringify([identity.workspaceId, identity.id]);
      if (this.avatarKey !== key || this.profileApi !== app.api) {
        this.clearProfile();
        this.avatarKey = key;
        this.profileApi = app.api;
        this.setData({ profile: { name: identity.name, avatar: '' } });
      }
      setChanged(this, {
        canSwitch: unified.canSwitch(),
        pending: c.pending.length,
        archive: c.archive.length,
      });
      if (
        this.foreground !== app.foreground ||
        !this.lastRead ||
        Date.now() - this.lastRead >= 1500
      )
        return this.reloadProfile();
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
  async onPullDownRefresh() {
    try {
      await this.reloadProfile();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  reloadProfile() {
    const api = this.profileApi;
    const key = this.avatarKey;
    if (!api || !key) return;
    if (this.reading?.key === key && this.reading.api === api) return this.reading.promise;
    const identity = api.identity;
    const foreground = this.app.foreground;
    const fetch = (this.avatarFetch = (this.avatarFetch || 0) + 1);
    const current = () =>
      key === this.avatarKey &&
      api === this.profileApi &&
      api.identity?.id === identity?.id &&
      api.identity?.workspaceId === identity?.workspaceId;
    const promise = Promise.all([api.personalProfile(), api.personalAvatar()])
      .then(async ([info, bytes]) => {
        if (!current()) return;
        if (info)
          setChanged(this, {
            profile: { ...this.data.profile, name: info.name || identity.name },
            subtitle: [info.department, info.jobTitle].filter(Boolean).join(' · '),
          });
        if (fetch !== this.avatarFetch) return;
        if (!bytes) {
          this.avatarBytes = null;
          if (this.data.profile.avatar) this.showEmployeeAvatar('');
          return;
        }
        const data = new Uint8Array(bytes);
        if (
          this.avatarBytes?.length === data.length &&
          data.every((byte, index) => byte === this.avatarBytes[index])
        )
          return;
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
        if (current() && fetch === this.avatarFetch) {
          this.avatarBytes = data;
          this.showEmployeeAvatar(path, path);
        } else fs.unlink({ filePath: path, fail() {} });
      })
      .catch((error) => {
        if (key !== this.avatarKey || api !== this.profileApi) return;
        if (error.status === 401 || error.status === 403 || !api.identity) {
          clearEmployeeViews(this.app);
          this.clearProfile();
          if (getCurrentPages().at(-1) === this) wx.reLaunch({ url: unified.entry });
        }
      })
      .finally(() => {
        if (current()) {
          this.foreground = foreground;
          this.lastRead = Date.now();
        }
        if (this.reading?.promise === promise) this.reading = null;
      });
    this.reading = { key, api, promise };
    return promise;
  },
  clearProfile() {
    this.avatarKey = undefined;
    this.profileApi = null;
    this.lastRead = 0;
    this.avatarBytes = null;
    this.showEmployeeAvatar('');
    this.setData({ profile: null, subtitle: '', pending: 0, archive: 0, canSwitch: false });
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
    this.clearProfile();
    this.releaseAvatar();
  },
  switchIdentity() {
    this.clearProfile();
    clearEmployeeViews(this.app);
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
    this.clearProfile();
    clearEmployeeViews(this.app);
    wx.reLaunch({ url: unified.entry });
  },
});
