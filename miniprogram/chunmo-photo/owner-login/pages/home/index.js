const { withUi } = require('../../ui-tuning');
const store = require('../../fixture-store');
const { setChanged } = require('../../../lib/page-data');
const { go, routes } = require('../../preview');

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
      activeTab: 'home',
      profileMounted: false,
      refreshingTab: '',
    },
    onLoad() {
      store.open(this);
      if (!this.data.ready) return;
      this.stopWatching = store.watchScope(() => {
        if (!store.isVerified()) {
          this.setData({
            project: null,
            recent: [],
            pendingCount: 0,
            boughtCount: 0,
            totalCount: 0,
            overdueCount: 0,
            profileMounted: false,
            ready: false,
          });
          return;
        }
        this.renderSnapshot();
        this.profile()?.renderSnapshot();
      });
      const capsule = wx.getMenuButtonBoundingClientRect?.();
      if (Number.isFinite(capsule?.left) && capsule.left > 0)
        this.setData({ capsuleStyle: `--home-capsule-left: ${capsule.left}px;` });
    },
    onShow() {
      if (this.data.ready) return this.refresh(true);
    },
    onUnload() {
      this.stopWatching?.();
      this.unloaded = true;
    },
    profile() {
      return this.selectComponent?.('#owner-profile');
    },
    refresh(force = false) {
      if (this.reading) return this.reading;
      const verified = store.isVerified();
      if (!verified) {
        this.renderSnapshot();
        return;
      }
      this.reading = store
        .refreshVerified()
        .then(() => {
          if (this.unloaded) return;
          this.renderSnapshot();
          const profile = this.profile();
          profile?.renderSnapshot();
          if (this.data.activeTab === 'profile') return profile?.refreshDesign(force);
        })
        .catch((error) => {
          if (this.unloaded) return;
          if (verified && !store.isVerified()) {
            this.expired();
          } else if (!this.data.project) {
            this.setData({ loading: false, error: error.message });
          } else if (this.data.project.id !== store.projectContext().project.id) {
            this.renderSnapshot();
            this.profile()?.renderSnapshot();
          }
        })
        .finally(() => {
          this.lastRead = Date.now();
          this.reading = null;
        });
      return this.reading;
    },
    onHomeScroll({ detail }) {
      setChanged(this, { scrolled: detail.scrollTop > 0 });
    },
    async refreshPane() {
      const tab = this.data.activeTab;
      this.setData({ refreshingTab: tab });
      try {
        await this.refresh(true);
      } finally {
        this.setData({ refreshingTab: '' });
      }
    },
    onPullDownRefresh() {
      return this.refreshPane().finally(() => wx.stopPullDownRefresh());
    },
    changeTab(event) {
      this.showTab(event.detail.tab);
    },
    expired() {
      wx.reLaunch({ url: routes.welcome });
    },
    revalidate() {
      void this.refresh(true);
    },
    showTab(tab, switchOpen = false) {
      if (!this.data.ready) return;
      if (tab === this.data.activeTab && !switchOpen) return;
      this.setData(
        { activeTab: tab, profileMounted: this.data.profileMounted || tab === 'profile' },
        () => {
          const profile = this.profile();
          if (tab === 'profile') {
            if (switchOpen) profile?.showProjects();
            void profile?.refreshDesign();
          }
          // The native scroll views stay mounted. A burst of taps shares validation.
          if (!this.lastRead || Date.now() - this.lastRead >= 1500) void this.refresh();
        },
      );
    },
    showHome() {
      this.showTab('home');
    },
    residenceChanged() {
      this.renderSnapshot();
      this.profile()?.renderSnapshot();
      this.setData({ activeTab: 'home', scrolled: false, homeScrollTarget: -1 }, () => {
        this.setData({ homeScrollTarget: 0 });
      });
      if (this.reading) void this.reading.then(() => this.refresh(true));
      else void this.refresh(true);
    },
    renderSnapshot() {
      try {
        const { project, projects, groups, today } = store.snapshot();
        setChanged(this, {
          project,
          canSwitch: projects.length > 1,
          pendingCount: groups.pending.length,
          boughtCount: groups.bought.length,
          overdueCount: groups.pending.filter(({ overdue }) => overdue).length,
          totalCount: groups.pending.length + groups.bought.length + groups.complete.length,
          recent: groups.pending.map((item) => ({
            ...item,
            homeDate: scheduleDate(item.due, today),
          })),
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
      if (this.data.canSwitch) this.showTab('profile', true);
    },
  }),
);
