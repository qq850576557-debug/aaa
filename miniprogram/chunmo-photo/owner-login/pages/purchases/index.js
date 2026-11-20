const store = require('../../fixture-store');
const { go, back } = require('../../preview');

const statuses = [
  { id: 'pending', label: '待采购' },
  { id: 'bought', label: '已购买' },
  { id: 'complete', label: '已完成' },
];
const valid = (state) => statuses.some(({ id }) => id === state);

Page({
  data: {
    ready: false,
    statusTop: 24,
    state: 'pending',
    statuses,
    loading: true,
    error: '',
    rows: [],
    project: null,
  },
  onLoad(options = {}) {
    if (store.open(this) && valid(options.state)) this.setData({ state: options.state });
  },
  onShow() {
    if (!this.data.ready) return;
    try {
      const { project, groups } = store.snapshot();
      this.setData({
        project,
        statuses: statuses.map((status) => ({ ...status, count: groups[status.id].length })),
        rows: groups[this.data.state],
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
