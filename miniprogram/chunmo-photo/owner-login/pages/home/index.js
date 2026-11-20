const store = require('../../fixture-store');
const { go } = require('../../preview');

Page({
  data: {
    ready: false,
    statusTop: 24,
    loading: true,
    error: '',
    project: null,
    canSwitch: false,
    pendingCount: 0,
    boughtCount: 0,
    recent: [],
  },
  onLoad() {
    store.open(this);
  },
  onShow() {
    if (!this.data.ready) return;
    try {
      const { project, projects, groups } = store.snapshot();
      this.setData({
        project,
        canSwitch: projects.length > 1,
        pendingCount: groups.pending.length,
        boughtCount: groups.bought.length,
        recent: groups.pending.slice(0, 3),
        error: '',
        loading: false,
      });
    } catch (error) {
      this.setData({ project: null, recent: [], loading: false, error: error.message });
    }
  },
  retry() {
    store.retry();
    this.onShow();
  },
  pending() {
    go('purchases', '?state=pending');
  },
  bought() {
    go('purchases', '?state=bought');
  },
  openPurchase(event) {
    go('purchase', '?id=' + encodeURIComponent(event.currentTarget.dataset.id));
  },
  profile() {
    go('profile');
  },
  contact() {
    wx.showModal({
      title: '联系春茉',
      content: '请通过已有的项目沟通渠道联系春茉。',
      showCancel: false,
    });
  },
});
