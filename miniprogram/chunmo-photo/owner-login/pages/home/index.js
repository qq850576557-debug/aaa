const { withUi } = require('../../ui-tuning');
const store = require('../../fixture-store');
const { go } = require('../../preview');

function scheduleDate(due, today) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!match) return due;
  const [, year, month, day] = match;
  return '预计 ' + (year === today.slice(0, 4) ? '' : year + '年') + month + '月' + day + '日';
}

Page(
  withUi('home', {
    data: {
      ready: false,
      statusTop: 24,
      capsuleStyle: '',
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
      if (!this.data.ready) return;
      const capsule = wx.getMenuButtonBoundingClientRect?.();
      if (Number.isFinite(capsule?.left) && capsule.left > 0)
        this.setData({ capsuleStyle: `--home-capsule-left: ${capsule.left}px;` });
    },
    onShow() {
      if (!this.data.ready) return;
      if (store.isVerified()) {
        const previous = this.data.project?.id;
        const scrollTop = this.scrollTop || 0;
        this.setData({ project: null, recent: [], loading: true, error: '' });
        return store.refreshVerified().then(
          () => {
            this.renderSnapshot();
            if (scrollTop && previous === this.data.project?.id)
              wx.nextTick(() => wx.pageScrollTo({scrollTop,duration:0}));
          },
          (error) => {
            this.setData({ project: null, loading: false, error: error.message });
            if (!store.isVerified()) wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
          },
        );
      }
      this.renderSnapshot();
    },
    onPageScroll({ scrollTop }) {
      this.scrollTop = scrollTop;
      const scrolled = scrollTop > 0;
      if (this.data.scrolled !== scrolled) this.setData({ scrolled });
    },
    onPullDownRefresh() {
      return Promise.resolve(this.onShow()).finally(() => wx.stopPullDownRefresh());
    },
    renderSnapshot() {
      try {
        const { project, projects, groups, today } = store.snapshot();
        this.setData({
          project,
          canSwitch: projects.length > 1,
          pendingCount: groups.pending.length,
          boughtCount: groups.bought.length,
          overdueCount: groups.pending.filter(({ overdue }) => overdue).length,
          totalCount: groups.pending.length + groups.bought.length + groups.complete.length,
          recent: groups.pending.map((item) => ({ ...item, homeDate: scheduleDate(item.due, today) })),
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
    switchResidence() {
      if (this.data.canSwitch) go('profile', '?switch=1');
    },
  }),
);
