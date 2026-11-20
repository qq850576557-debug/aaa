const { startPreview } = require('../../preview');

Page({
  data: {
    ready: false,
    statusTop: 24,
    keyboardOpen: false,
    account: '',
    password: '',
    passwordFocused: false,
    showPassword: false,
    feedback: '',
  },
  onLoad() {
    startPreview(this);
  },
  onHide() {
    this.setData({
      account: '',
      password: '',
      passwordFocused: false,
      showPassword: false,
      keyboardOpen: false,
      feedback: '',
    });
  },
  back() {
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: '/owner-login/pages/welcome/index' }),
    });
  },
  accountInput(event) {
    this.setData({ account: event.detail.value, feedback: '' });
  },
  passwordInput(event) {
    this.setData({ password: event.detail.value, feedback: '' });
  },
  focusPassword() {
    this.setData({ passwordFocused: true });
  },
  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },
  keyboardChange(event) {
    const keyboardOpen = event.detail.height > 0;
    if (this.data.keyboardOpen !== keyboardOpen) this.setData({ keyboardOpen });
  },
  keyboardBlur() {
    if (this.data.keyboardOpen) this.setData({ keyboardOpen: false });
  },
  passwordBlur() {
    this.setData({ passwordFocused: false });
    this.keyboardBlur();
  },
  submit() {
    if (!this.data.account.trim() || !this.data.password) {
      this.setData({ feedback: '请填写员工账号和密码' });
      return;
    }
    wx.hideKeyboard?.({ fail() {} });
    this.setData({
      password: '',
      passwordFocused: false,
      showPassword: false,
      feedback: '当前为界面预览，尚未进行账号验证',
    });
  },
});
