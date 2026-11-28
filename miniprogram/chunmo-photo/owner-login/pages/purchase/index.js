const store = require('../../fixture-store');
const { back } = require('../../preview');
const { setChanged } = require('../../../lib/page-data');
const maxPhoto = 512 * 1024;
const statusActions = {
  finish: {
    state: 'bought',
    title: '确认到货',
    text: '确认这项采购已到货？',
    success: '已确认到货',
  },
  reopen: {
    state: 'complete',
    title: '撤销到货',
    text: '撤销后，此项会恢复到货前的采购状态。',
    success: '已撤销到货',
  },
  withdraw: {
    state: 'bought',
    title: '撤销下单',
    text: '撤销后，此项会回到待采购。',
    success: '已恢复待采购',
  },
};

async function encodePhoto(path) {
  const fs = wx.getFileSystemManager();
  if (fs.statSync(path).size > maxPhoto)
    path = (await wx.compressImage({ src: path, quality: 60, compressedWidth: 1200 })).tempFilePath;
  if (fs.statSync(path).size > maxPhoto) throw Error('图片超过 512 KB，请选择较小的图片');
  return new Promise((resolve, reject) =>
    fs.readFile({
      filePath: path,
      encoding: 'base64',
      success: ({ data }) => resolve(data),
      fail: () => reject(Error('图片读取失败，请重新选择')),
    }),
  );
}

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
    verified: false,
    photoState: '',
    photoSrc: '',
    pickingPhoto: false,
  },
  onLoad(options = {}) {
    if (store.open(this)) this.setData({ id: String(options.id || '') });
  },
  onShow(fresh) {
    if (!this.data.ready || this.data.saving || this.data.pickingPhoto) return;
    if (store.isVerified()) {
      if (!this.data.item) this.setData({ loading: true, error: '', unavailable: false });
      return store.refreshVerified(fresh === true).then(
        () => this.renderSnapshot(),
        (error) => {
          if (!store.isVerified()) {
            this.setData({
              item: null,
              project: null,
              photoSrc: '',
              loading: false,
              error: error.message,
            });
            wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
          } else if (!this.data.item) this.setData({ loading: false, error: error.message });
          else if (this.data.project?.id !== store.snapshot().project.id) this.renderSnapshot();
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
      const samePhoto =
        project.id === this.data.project?.id &&
        item?.feedback?.imageId === this.data.item?.feedback?.imageId;
      setChanged(this, {
        item: item || null,
        project,
        unavailable: !item,
        loading: false,
        error: '',
        verified: store.isVerified(),
        ...(samePhoto ? {} : { photoSrc: '' }),
      });
      if (!item) this.closeSheet();
    } catch (error) {
      this.setData({ item: null, loading: false, error: error.message });
      this.closeSheet();
    }
  },
  onHide() {
    this._photoRequest = null;
    this.setData({ photoSrc: '' });
    if (!this.data.pickingPhoto) this.closeSheet();
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
        draft: { ...store.blankFeedback, ...item.feedback },
        photoState: item.feedback?.imageId ? 'existing' : '',
        draftError: '',
        focusedField: '',
      });
  },
  closeSheet() {
    if (!this.data.sheet || this.data.saving) return;
    this._photoPath = undefined;
    this._encodedPhoto = undefined;
    this.setData({
      sheet: false,
      keyboardHeight: 0,
      focusedField: '',
      draft: { ...store.blankFeedback },
      draftError: '',
      photoState: '',
    });
  },
  stop() {},
  async choosePhoto() {
    if (!this.data.sheet || !this.data.verified || this.data.saving || this.data.pickingPhoto)
      return;
    this.setData({ pickingPhoto: true });
    try {
      const result = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album'],
        sizeType: ['compressed'],
      });
      const path = result.tempFiles?.[0]?.tempFilePath;
      if (!path || !this.data.sheet) return;
      this._photoPath = path;
      this._encodedPhoto = undefined;
      this.setData({ photoState: 'new', draftError: '' });
    } catch (error) {
      if (!String(error?.errMsg).includes('cancel'))
        this.setData({ draftError: '无法选取图片，请重试' });
    } finally {
      this.setData({ pickingPhoto: false });
    }
  },
  removePhoto() {
    if (!this.data.sheet || this.data.saving || this.data.pickingPhoto) return;
    this._photoPath = undefined;
    this._encodedPhoto = undefined;
    this.setData({ photoState: 'remove', draftError: '' });
  },
  async showPhoto() {
    const { item, project } = this.data;
    const imageId = item?.feedback?.imageId;
    if (!imageId || !project || !store.isVerified()) return;
    const request = {};
    this._photoRequest = request;
    try {
      const { image } = await store.photo(project.id, item.id, imageId);
      if (this._photoRequest === request && this.data.item?.feedback?.imageId === imageId)
        this.setData({ photoSrc: 'data:image/jpeg;base64,' + image });
    } catch (error) {
      if (this._photoRequest !== request) return;
      if ([401, 403, 404].includes(error.statusCode)) this.onShow();
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },
  copyLink() {
    const link = this.data.item?.feedback?.link;
    if (link) wx.setClipboardData({ data: link });
  },
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
    if (!sheet || !item || !project || this.data.saving || this.data.pickingPhoto) return;
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
    const verified = store.isVerified();
    this.setData({ saving: true, draftError: '' });
    try {
      if (action === 'purchase') {
        if (this._photoPath && !this._encodedPhoto)
          this._encodedPhoto = await encodePhoto(this._photoPath);
        const image = this._photoPath
          ? this._encodedPhoto
          : this.data.photoState === 'remove'
            ? ''
            : undefined;
        await store.update(item.id, project.id, item.version, { ...draft, image });
      } else await store.changeStatus(item.id, project.id, item.version, action);
    } catch (error) {
      this.setData({ saving: false });
      if (verified && !store.isVerified()) {
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
    await this.onShow(true);
    wx.showToast({
      title: action === 'purchase' ? '购买信息已保存' : statusActions[action].success,
      icon: 'none',
    });
  },
  confirmStatus(event) {
    const { item, project } = this.data;
    const { action } = event.currentTarget.dataset;
    const option = statusActions[action];
    if (!option || item?.state !== option.state || !project || this.data.saving) return;
    wx.showModal({
      title: option.title,
      content: option.text,
      confirmText: action === 'finish' ? '确认' : '撤销',
      success: ({ confirm }) => {
        if (!confirm || this.data.saving) return;
        void this.saveVerified(action, item, project);
      },
    });
  },
});
