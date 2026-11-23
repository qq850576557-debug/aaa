const store = require('../../fixture-store');
const { go, back } = require('../../preview');

const statuses = [
  { id: 'pending', label: '待采购' },
  { id: 'bought', label: '已下单' },
  { id: 'complete', label: '已到货' },
];
const valid = (state) => statuses.some(({ id }) => id === state);

Page({
  data: {
    ready: false,
    statusTop: 24,
    state: 'pending',
    overdueOnly: false,
    statuses,
    loading: true,
    error: '',
    rows: [],
    project: null,
  },
  onLoad(options = {}) {
    if (!store.open(this)) return;
    if (options.overdue === '1') this.setData({ overdueOnly: true });
    else if (valid(options.state)) this.setData({ state: options.state });
  },
  onShow() {
    if (!this.data.ready) return;
    if (store.isVerified()) {
      this.setData({ loading: true, error: '', rows: [] });
      return store.refreshVerified().then(
        () => this.renderSnapshot(),
        (error) => {
          this.setData({ loading: false, error: error.message });
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
      const { project, groups } = store.snapshot();
      this.setData({
        project,
        statuses: statuses.map((status) => ({ ...status, count: groups[status.id].length })),
        rows: this.data.overdueOnly
          ? groups.pending.filter(({ overdue }) => overdue)
          : groups[this.data.state],
        loading: false,
        error: '',
      });
    } catch (error) {
      this.setData({ project: null, rows: [], loading: false, error: error.message });
    }
  },
  showState(event) {
    const { state } = event.currentTarget.dataset;
    if (valid(state) && this.data.state !== state) {
      this.setData({ state });
      this.renderSnapshot();
    }
  },
  retry() {
    store.retry();
    this.onShow();
  },
  openPurchase(event) {
    go('purchase', '?id=' + encodeURIComponent(event.currentTarget.dataset.id));
  },
  back() {
    back();
  },
});
