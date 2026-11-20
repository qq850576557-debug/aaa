const { startPreview } = require('../../preview');

Page({
  data: { ready: false, statusTop: 24, agreed: false, feedback: '' },
  onLoad() {
    startPreview(this);
  },
  toggleAgreement() {
    this.setData({ agreed: !this.data.agreed, feedback: '' });
  },
  quickLogin() {
    this.setData({
      feedback: this.data.agreed ? '手机号验证将在后续阶段接入' : '请先阅读并勾选协议及隐私指引',
    });
  },
  openEmployee() {
    wx.navigateTo({ url: '/owner-login/pages/employee/index' });
  },
  showPolicy(event) {
    wx.showModal({
      title: event.currentTarget.dataset.title,
      content: '正式内容待春茉确认，本页用于登录界面验收。',
      showCancel: false,
    });
  },
});
