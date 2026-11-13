const { enter } = require('../../lib/session');
const { message, privacy, call } = require('../../lib/platform');
Page({
  data: { login: '', password: '', busy: false, error: '', privacyVisible: false },
  accountInput(e) {
    // Normal text input; the OS/WeChat controls availability of third-party IMEs.
    this.setData({ login: e.detail.value.replace(/[\r\n]/g, '') });
  },
  passwordInput(e) {
    this.setData({ password: e.detail.value });
  },
  privacyContract() {
    wx.openPrivacyContract({
      fail: () => this.setData({ error: '隐私指引尚未配置，请联系负责人' }),
    });
  },
  async submit() {
    if (this.data.busy) return;
    const login = this.data.login.trim(),
      password = this.data.password;
    if (!login || !password) return this.setData({ error: '请填写员工账号和密码' });
    this.setData({ busy: true, error: '', password: '' });
    try {
      await privacy();
      const identity = await getApp().api.login(login, password);
      const engine = await enter(identity);
      const pending = engine.list().filter((t) => t.stage !== 'saved' && t.stage !== 'cancelled');
      if (pending.length) {
        const choice = await call('showModal', {
          title: '有待处理照片',
          content: '本机有' + pending.length + '张照片待处理，是否先查看？',
          confirmText: '查看照片',
          cancelText: '先拍照',
        });
        if (choice.confirm) {
          await call('redirectTo', { url: '/pages/results/index?recover=1' });
          return;
        }
      }
      await call('redirectTo', { url: '/pages/places/index' });
    } catch (error) {
      this.setData({ error: message(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
});
