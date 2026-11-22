const store = require('../../fixture-store');
const { back } = require('../../preview');

Page({
  data: {
    ready: false,
    statusTop: 24,
    loading: true,
    error: '',
    item: null,
    project: null,
    id: '',
    unavailable: false,
    sheet: false,
    draft: store.blankFeedback,
    draftError: '',
    saving: false,
    keyboardHeight: 0,
    focusedField: '',
  },
  onLoad(options = {}) {
    if (store.open(this)) this.setData({ id: String(options.id || '') });
  },
  onShow() {
    if (!this.data.ready || this.data.saving) return;
    if (store.isVerified()) {
      this.setData({ loading: true, error: '', item: null, unavailable: false });
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
      const item = Object.values(groups)
        .flat()
        .find((entry) => entry.id === this.data.id);
      this.setData({ item: item || null, project, unavailable: !item, loading: false, error: '' });
      if (!item) this.closeSheet();
    } catch (error) {
      this.setData({ item: null, loading: false, error: error.message });
      this.closeSheet();
    }
  },
  onHide() {
    this.closeSheet();
  },
  retry() {
    store.retry();
    this.onShow();
  },
  back() {
    back('purchases');
  },
  openSheet() {
    const item = this.data.item;
    if (item && item.state !== 'complete')
      this.setData({
        sheet: true,
        draft: item.state === 'bought' ? { ...item.feedback } : { ...store.blankFeedback },
        draftError: '',
        focusedField: '',
      });
  },
  closeSheet() {
    if (!this.data.sheet || this.data.saving) return;
    this.setData({
      sheet: false,
      keyboardHeight: 0,
      focusedField: '',
      draft: { ...store.blankFeedback },
      draftError: '',
    });
  },
  stop() {},
  writeFeedback(event) {
    const { field } = event.currentTarget.dataset;
    if (this.data.sheet && Object.hasOwn(store.blankFeedback, field))
      this.setData({ ['draft.' + field]: event.detail.value, draftError: '' });
  },
  focusFeedback(event) {
    const focusedField = event.currentTarget.dataset.scrollId;
    if (focusedField) this.setData({ focusedField });
  },
  keyboardChange(event) {
    if (this.data.sheet) this.setData({ keyboardHeight: Math.max(0, event.detail.height || 0) });
  },
  confirm() {
    const { item, project, draft, sheet } = this.data;
    if (!sheet || !item || !project || this.data.saving) return;
    if (store.isVerified()) {
      void this.saveVerified('purchase', item, project, draft);
      return;
    }
    try {
      store.update(item.id, project.id, item.version, draft);
      this.closeSheet();
      this.onShow();
      wx.showToast({ title: '购买信息已保存', icon: 'none' });
    } catch (error) {
      this.setData({ draftError: error.message });
    }
  },
  async saveVerified(action, item, project, draft) {
    this.setData({ saving: true, draftError: '' });
    try {
      if (action === 'purchase') await store.update(item.id, project.id, item.version, draft);
      else await store.revoke(item.id, project.id, item.version);
    } catch (error) {
      this.setData({ saving: false });
      if (!store.isVerified()) {
        wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
      } else if ([404, 409].includes(error.statusCode)) {
        this.closeSheet();
        this.onShow();
        wx.showToast({ title: error.message, icon: 'none' });
      } else if (action === 'purchase') {
        this.setData({ draftError: error.message });
      } else {
        wx.showToast({ title: error.message, icon: 'none' });
      }
      return;
    }
    this.setData({ saving: false });
    this.closeSheet();
    this.onShow();
    wx.showToast({
      title: action === 'purchase' ? '购买信息已保存' : '已恢复待采购',
      icon: 'none',
    });
  },
  cancelPurchase() {
    const { item, project } = this.data;
    if (item?.state !== 'bought' || !project || this.data.saving) return;
    wx.showModal({
      title: '撤销购买确认',
      content: '撤销后，此项会回到待采购。',
      confirmText: '撤销',
      success: ({ confirm }) => {
        if (!confirm || this.data.saving) return;
        if (store.isVerified()) {
          void this.saveVerified('withdraw', item, project);
          return;
        }
        try {
          store.revoke(item.id, project.id, item.version);
          this.onShow();
          wx.showToast({ title: '已恢复待采购', icon: 'none' });
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' });
        }
      },
    });
  },
});
