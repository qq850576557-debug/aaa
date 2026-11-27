const unified = require('../../../lib/unified-login');
const { withUi } = require('../../ui-tuning');
const store = require('../../fixture-store');
const avatar = require('../../avatar');
const { avatarEditor } = require('../../profile-avatar');
const ownerSession = require('../../owner-session');
const { back, routes, showPolicy } = require('../../preview');

Page(
  withUi('profile', {
    designEpoch: 0,
    ...avatarEditor('owner', function (path) {
      store.setAvatar(path);
      this.renderSnapshot();
    }),
    data: {
      ready: false,
      statusTop: 24,
      loading: true,
      error: '',
      owner: null,
      project: null,
      projects: [],
      switchOpen: false,
      cropOpen: false,
      cropReady: false,
      avatarLoading: false,
      savingAvatar: false,
      privacyVisible: false,
      maxZoom: avatar.MAX_ZOOM,
      design: {},
      designLoading: false,
    },
    onLoad(options = {}) {
      if (ownerSession.unified()) this.setData({ canSwitch: unified.canSwitch() });
      if (store.open(this) && options.switch === '1') this.setData({ switchOpen: true });
    },
    onShow() {
      if (!this.data.ready) return;
      if (store.isVerified()) {
        return store.refreshVerified().then(
          () => {
            this.renderSnapshot();
            return this.refreshDesign();
          },
          (error) => {
            ++this.designEpoch;
            this.setData({
              project: null,
              design: {},
              designLoading: false,
              loading: false,
              error: error.message,
            });
            if (!store.isVerified()) wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
          },
        );
        return;
      }
      this.renderSnapshot();
    },
    renderSnapshot() {
      try {
        const { owner, project, projects } = store.snapshot();
        this.setData({
          owner,
          project,
          projects,
          switchOpen: projects.length > 1 && this.data.switchOpen,
          loading: false,
          error: '',
        });
      } catch (error) {
        this.setData({
          owner: store.ownerIdentity(),
          project: null,
          projects: [],
          loading: false,
          error: error.message,
        });
      }
    },
    onUnload() {
      ++this.designEpoch;
      this.releaseAvatar();
    },
    onPullDownRefresh() {
      return Promise.resolve(this.onShow()).finally(() => wx.stopPullDownRefresh());
    },
    async refreshDesign() {
      const project = this.data.project?.id;
      const epoch = ++this.designEpoch;
      if (!project || !store.isVerified() || !ownerSession.unified()) return;
      this.setData({ design: {}, designLoading: true, designError: '' });
      try {
        const data = await ownerSession.projectDesign(project);
        if (epoch === this.designEpoch)
          this.setData({
            design: {
              rendering: !!(data.rendering || data.renderingUnavailable),
              panorama: !!(data.panorama || data.panoramaUnavailable),
            },
          });
      } catch (error) {
        if (epoch !== this.designEpoch) return;
        if (error.statusCode === 401) {
          store.end();
          wx.reLaunch({ url: routes.welcome });
          return;
        }
        if (error.statusCode !== 404)
          this.setData({ designError: '暂时无法获取设计成果，点击卡片重试' });
      } finally {
        if (epoch === this.designEpoch) this.setData({ designLoading: false });
      }
    },
    openDesign(event) {
      const kind = event.currentTarget.dataset.kind;
      const project = this.data.project?.id;
      if (!project || !['rendering', 'panorama'].includes(kind) || this.data.designLoading) return;
      if (!store.isVerified()) return wx.showToast({ title: '暂未发布', icon: 'none' });
      wx.navigateTo({
        url:
          '/owner-login/pages/design/index?kind=' +
          kind +
          '&project=' +
          encodeURIComponent(project),
      });
    },
    switchIdentity() {
      wx.reLaunch({ url: unified.entry + '?choose=1' });
    },
    avatarFailed(event) {
      if (event.target.dataset.avatar === this.data.owner?.avatar)
        this.setData({ 'owner.avatar': '' });
    },
    retry() {
      store.retry();
      this.onShow();
    },
    toggleProjects() {
      if (this.data.projects.length > 1) this.setData({ switchOpen: !this.data.switchOpen });
    },
    chooseProject(event) {
      const { id } = event.currentTarget.dataset;
      if (id === this.data.project?.id) return;
      try {
        store.choose(id);
        ++this.designEpoch;
        this.setData({ design: {}, designError: '', designLoading: true });
        back();
      } catch (error) {
        wx.showToast({ title: error.message, icon: 'none' });
      }
    },
    showPolicy,
    logOut() {
      this.resetCrop();
      void ownerSession.logout();
      store.end();
      wx.reLaunch({ url: routes.welcome });
    },
    back() {
      back();
    },
  }),
);
