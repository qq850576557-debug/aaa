const { withUi } = require('../../ui-tuning');
const { startPreview, routes, showPolicy } = require('../../preview');
const { begin, modes } = require('../../fixture-store');

Page(
  withUi('login', {
    data: { ready: false, statusTop: 24, agreed: false, feedback: '', busy: false, mode: 'review' },
    onLoad(options = {}) {
      if (startPreview(this) && modes.includes(options.mode)) this.setData({ mode: options.mode });
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
    openEmployee() {
      wx.navigateTo({ url: '/owner-login/pages/employee/index' });
    },
    showPolicy,
  }),
);
