const store = require('../../fixture-store');
const { go, back } = require('../../preview');

const statuses = [
  { id: 'pending', label: '待采购' },
  { id: 'bought', label: '已购买' },
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
    else if (options.state === 'complete') this.setData({ state: 'bought' });
    else if (valid(options.state)) this.setData({ state: options.state });
  },
  onShow() {
    if (!this.data.ready) return;
    try {
      const { project, groups } = store.snapshot();
      const visible = {
        pending: groups.pending,
        bought: [...groups.bought, ...groups.complete].sort(
          (a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id),
        ),
      };
      this.setData({
        project,
        statuses: statuses.map((status) => ({ ...status, count: visible[status.id].length })),
        rows: this.data.overdueOnly
          ? groups.pending.filter(({ overdue }) => overdue)
          : visible[this.data.state],
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
      this.onShow();
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
