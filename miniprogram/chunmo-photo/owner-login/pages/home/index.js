const { withUi } = require('../../ui-tuning');
const store = require('../../fixture-store');
const { go } = require('../../preview');

Page(
  withUi('home', {
    data: {
      ready: false,
      statusTop: 24,
      loading: true,
      error: '',
      project: null,
      canSwitch: false,
      pendingCount: 0,
      boughtCount: 0,
      overdueCount: 0,
      totalCount: 0,
      recent: [],
    },
    onLoad() {
      store.open(this);
    },
    onShow() {
      if (!this.data.ready) return;
      if (store.isVerified()) {
        this.setData({ project: null, recent: [], loading: true, error: '' });
        return store.refreshVerified().then(
          () => this.renderSnapshot(),
          (error) => {
            this.setData({ project: null, loading: false, error: error.message });
            if (!store.isVerified()) wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
          },
        );
      }
      this.renderSnapshot();
    },
    onPullDownRefresh() {
      return Promise.resolve(this.onShow()).finally(() => wx.stopPullDownRefresh());
    },
    renderSnapshot() {
      try {
        const { project, projects, groups } = store.snapshot();
        this.setData({
          project,
          canSwitch: projects.length > 1,
          pendingCount: groups.pending.length,
          boughtCount: groups.bought.length,
          overdueCount: groups.pending.filter(({ overdue }) => overdue).length,
          totalCount: groups.pending.length + groups.bought.length + groups.complete.length,
          recent: groups.pending,
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
    overdue() {
      go('purchases', '?overdue=1');
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
    switchResidence() {
      if (this.data.canSwitch) go('profile', '?switch=1');
    },
  }),
);
