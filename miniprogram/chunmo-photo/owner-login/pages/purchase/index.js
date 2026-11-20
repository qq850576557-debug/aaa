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
    keyboardHeight: 0,
    focusedField: '',
  },
  onLoad(options = {}) {
    if (store.open(this)) this.setData({ id: String(options.id || '') });
  },
  onShow() {
    if (!this.data.ready) return;
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
    if (!this.data.sheet) return;
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
    if (!sheet || !item || !project) return;
    try {
      store.update(item.id, project.id, item.version, draft);
      this.closeSheet();
      this.onShow();
      wx.showToast({ title: '购买信息已保存', icon: 'none' });
    } catch (error) {
      this.setData({ draftError: error.message });
    }
  },
  cancelPurchase() {
    const { item, project } = this.data;
    if (item?.state !== 'bought' || !project) return;
    wx.showModal({
      title: '撤销购买确认',
      content: '撤销后，此项会回到待采购。',
      confirmText: '撤销',
      success: ({ confirm }) => {
        if (!confirm) return;
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
