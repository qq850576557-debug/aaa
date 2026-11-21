const { withUi } = require('../../ui-tuning');
const { startPreview, routes, showPolicy } = require('../../preview');
const { begin, beginVerified, modes } = require('../../fixture-store');
const ownerSession = require('../../owner-session');

Page(
  withUi('login', {
    data: {
      ready: false,
      statusTop: 24,
      agreed: false,
      feedback: '',
      busy: false,
      mode: 'review',
      live: false,
      invite: '',
    },
    onLoad(options = {}) {
      if (!startPreview(this)) return;
      if (ownerSession.enabled()) {
        this.setData({
          live: true,
          invite: typeof options.invite === 'string' ? options.invite : '',
        });
        void this.restoreSession();
      } else if (modes.includes(options.mode)) this.setData({ mode: options.mode });
    },
    toggleAgreement() {
      this.setData({ agreed: !this.data.agreed, feedback: '' });
    },
    quickLogin() {
      if (!this.data.ready || this.data.busy) return;
      if (!this.data.agreed) {
        this.setData({ feedback: '请先阅读并勾选协议及隐私指引' });
        return;
      }
      if (this.data.live) return;
      if (!begin(this.data.mode)) {
        this.setData({ feedback: '暂无访问授权，请联系春茉。' });
        return;
      }
      this.setData({ busy: true });
      wx.redirectTo({
        url: routes.home,
        success: () => wx.showToast({ title: '正在查看演示数据', icon: 'none' }),
        fail: () => this.setData({ busy: false, feedback: '暂时无法打开，请重试。' }),
      });
    },
    async restoreSession() {
      if (this.data.busy) return;
      this.setData({ busy: true });
      try {
        const value = await ownerSession.session();
        if (!value) return;
        beginVerified(value);
        wx.redirectTo({ url: routes.home });
      } catch (error) {
        this.setData({ feedback: error.message });
      } finally {
        this.setData({ busy: false });
      }
    },
    async authorizePhone(event) {
      if (!this.data.live || !this.data.agreed || this.data.busy) return;
      const phoneCode = event.detail.code;
      if (!phoneCode) {
        this.setData({ feedback: '请授权手机号后重试' });
        return;
      }
      this.setData({ busy: true, feedback: '' });
      try {
        const value = await ownerSession.login(phoneCode, this.data.invite);
        beginVerified(value);
        this.setData({ invite: '' });
        wx.redirectTo({ url: routes.home });
      } catch (error) {
        this.setData({ feedback: error.message });
      } finally {
        this.setData({ busy: false });
      }
    },
    openEmployee() {
      wx.navigateTo({ url: '/owner-login/pages/employee/index' });
    },
    showPolicy,
  }),
);
