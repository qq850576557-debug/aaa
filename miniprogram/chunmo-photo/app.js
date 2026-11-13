const { Api } = require('./lib/api');
App({
  api: null,
  engine: null,
  store: null,
  place: null,
  captureIds: [],
  privacyResolvers: [],
  volatilePhotos: new Map(),
  onLaunch() {
    this.api = new Api();
    this.privacyResolvers = [];
    if (wx.onNeedPrivacyAuthorization)
      wx.onNeedPrivacyAuthorization((resolve) => {
        this.privacyResolvers.push(resolve);
        const pages = getCurrentPages(),
          page = pages[pages.length - 1];
        if (page) page.setData({ privacyVisible: true });
      });
  },
  onShow() {
    if (this.engine) this.engine.active = true;
  },
  onHide() {
    if (this.engine) this.engine.active = false;
  },
  resolvePrivacy(agree) {
    this.privacyResolvers
      .splice(0)
      .forEach((resolve) =>
        resolve(
          agree ? { event: 'agree', buttonId: 'chunmo-privacy-agree' } : { event: 'disagree' },
        ),
      );
    const pages = getCurrentPages();
    pages.forEach((p) => p.setData({ privacyVisible: false }));
  },
});
