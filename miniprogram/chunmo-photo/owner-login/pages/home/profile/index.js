const unified = require('../../../../lib/unified-login');
const { withUi } = require('../../../ui-tuning');
const store = require('../../../fixture-store');
const avatar = require('../../../avatar');
const { avatarEditor } = require('../../../profile-avatar');
const { setChanged } = require('../../../../lib/page-data');
const ownerSession = require('../../../owner-session');
const { routes, showPolicy } = require('../../../preview');

const profile = withUi('profile', {
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
    maxZoom: avatar.MAX_ZOOM,
    design: {},
    designLoading: false,
  },
  onLoad() {
    if (!store.open(this)) return;
    if (ownerSession.unified()) this.setData({ canSwitch: unified.canSwitch() });
    this.renderSnapshot();
  },
  showProjects() {
    if (this.data.projects.length > 1) this.setData({ switchOpen: true });
  },
  renderSnapshot() {
    try {
      const { owner, project, projects } = store.projectContext();
      if (this.data.project?.id !== project?.id) {
        ++this.designEpoch;
        this.designRead = null;
        this.designChecked = null;
        this.setData({ design: {}, designLoading: false, designError: '' });
      }
      setChanged(this, {
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
  refreshDesign(force = false) {
    const project = this.data.project?.id;
    if (!project || !store.isVerified() || !ownerSession.unified()) return;
    if (this.designRead?.project === project) return this.designRead.promise;
    if (!force && this.designChecked === project && Date.now() - this.designAt < 1500) return;
    const epoch = ++this.designEpoch;
    if (this.designChecked !== project) setChanged(this, { designLoading: true, designError: '' });
    const promise = ownerSession
      .projectDesign(project)
      .then(
        (data) => {
          if (epoch !== this.designEpoch) return;
          setChanged(this, {
            design: {
              rendering: !!(data.rendering || data.renderingUnavailable),
              panorama: !!(data.panorama || data.panoramaUnavailable),
            },
            designError: '',
          });
        },
        (error) => {
          if (epoch !== this.designEpoch) return;
          if (error.statusCode === 401) {
            store.end();
            this.triggerEvent('expired');
          } else if ([403, 404].includes(error.statusCode)) {
            this.setData({ design: {} });
            this.triggerEvent('revalidate');
          } else if (this.designChecked !== project) {
            this.setData({ designError: '暂时无法获取设计成果，点击卡片重试' });
          }
        },
      )
      .finally(() => {
        if (epoch !== this.designEpoch) return;
        this.designChecked = project;
        this.designAt = Date.now();
        this.designRead = null;
        setChanged(this, { designLoading: false });
      });
    this.designRead = { project, promise };
    return promise;
  },
  openDesign(event) {
    const kind = event.currentTarget.dataset.kind;
    const project = this.data.project?.id;
    if (!project || !['rendering', 'panorama'].includes(kind) || this.data.designLoading) return;
    if (!store.isVerified()) return wx.showToast({ title: '暂未发布', icon: 'none' });
    wx.navigateTo({
      url:
        '/owner-login/pages/design/index?kind=' + kind + '&project=' + encodeURIComponent(project),
    });
  },
  switchIdentity() {
    store.end();
    wx.reLaunch({ url: unified.entry + '?choose=1' });
  },
  avatarFailed(event) {
    if (event.target.dataset.avatar === this.data.owner?.avatar)
      this.setData({ 'owner.avatar': '' });
  },
  retry() {
    store.retry();
    this.triggerEvent('revalidate');
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
      this.triggerEvent('residence');
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
    this.triggerEvent('home');
  },
});
const {
  data,
  designEpoch,
  avatarEpoch,
  cropSession,
  dragOrigin,
  onLoad,
  onShow,
  onUnload,
  ...methods
} = profile;

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { privacyVisible: Boolean },
  data,
  lifetimes: {
    attached() {
      Object.assign(this, {
        designEpoch,
        avatarEpoch,
        cropSession,
        dragOrigin,
        avatarComponent: true,
      });
      onLoad.call(this);
    },
    detached() {
      onUnload.call(this);
    },
  },
  methods,
});
