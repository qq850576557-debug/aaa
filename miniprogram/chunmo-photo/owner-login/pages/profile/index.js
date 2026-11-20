const store = require('../../fixture-store');
const { back, routes, showPolicy } = require('../../preview');

Page({
  data: {
    ready: false,
    statusTop: 24,
    loading: true,
    error: '',
    project: null,
    projects: [],
  },
  onLoad() {
    store.open(this);
  },
  onShow() {
    if (!this.data.ready) return;
    try {
      const { project, projects } = store.snapshot();
      this.setData({ project, projects, loading: false, error: '' });
    } catch (error) {
      this.setData({ project: null, projects: [], loading: false, error: error.message });
    }
  },
  retry() {
    store.retry();
    this.onShow();
  },
  chooseProject(event) {
    const { id } = event.currentTarget.dataset;
    if (id === this.data.project?.id) return;
    try {
      store.choose(id);
      back();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },
  showPolicy,
  logOut() {
    store.end();
    wx.reLaunch({ url: routes.welcome });
  },
  back() {
    back();
  },
});
