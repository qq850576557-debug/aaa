const { requireSession, clearEmployeeViews } = require('../../lib/session');
const { setChanged } = require('../../lib/page-data');
Page({
  data: { pending: 0, privacyVisible: false },
  onShow() {
    const app = requireSession();
    if (!app) return setChanged(this, { pending: 0 });
    this.visible = true;
    const { pending, failed } = app.engine.stats();
    setChanged(this, { pending: pending + failed });
    const api = app.api;
    if (this.checking?.api === api) return this.checking.promise;
    const foreground = app.foreground;
    if (
      this.checked?.api === api &&
      this.checked.foreground === foreground &&
      Date.now() - this.checked.time < 1500
    )
      return;
    const identity = api.identity;
    const promise = api
      .request('session')
      .catch((error) => {
        if (app.api !== api || (api.identity && api.identity !== identity)) return;
        if ([401, 403].includes(error.status) || !api.identity) {
          clearEmployeeViews(app);
          setChanged(this, { pending: 0 });
          if (this.visible) wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
        }
      })
      .finally(() => {
        if (this.checking?.promise === promise) {
          this.checked = { api, foreground, time: Date.now() };
          this.checking = null;
        }
      });
    this.checking = { api, promise };
    return promise;
  },
  onHide() {
    this.visible = false;
  },
  camera() {
    wx.navigateTo({ url: '/pages/places/index' });
  },
  recover() {
    wx.navigateTo({ url: '/pages/results/index?recover=1' });
  },
});
