const { withUi } = require('../../ui-tuning');
const { startPreview, routes, showPolicy } = require('../../preview');
const { begin, beginVerified, modes } = require('../../fixture-store');
const ownerSession = require('../../owner-session');
const invitePattern = /^[a-f0-9]{64}$/;

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
      formal: false,
      inviteReady: false,
      privacyVisible: false,
      invite: '',
    },
    onLoad(options = {}) {
      if (!startPreview(this)) return;
      const formal = ownerSession.productionBuild();
      this.setData({ formal });
      if (ownerSession.enabled()) {
        const invite =
          typeof options.invite === 'string' && invitePattern.test(options.invite)
            ? options.invite
            : '';
        this.setData({
          live: true,
          invite,
          inviteReady: Boolean(invite),
        });
        void this.restoreSession();
      } else if (formal) {
        this.setData({ feedback: '业主采购入口暂未开放' });
      } else if (modes.includes(options.mode)) this.setData({ mode: options.mode });
    },
    toggleAgreement() {
      this.setData({ agreed: !this.data.agreed, feedback: '' });
    },
    onUnload() {
      if (this.data.privacyVisible) this.rejectLoginPrivacy();
    },
    agreeLoginPrivacy() {
      getApp().resolvePrivacy(true);
    },
    rejectLoginPrivacy() {
      getApp().resolvePrivacy(false);
    },
    quickLogin() {
      if (!this.data.ready || this.data.busy) return;
      if (this.data.formal && !this.data.live) {
        this.setData({ feedback: '业主采购入口暂未开放' });
        return;
      }
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
        this.setData({ invite: '', inviteReady: false });
        wx.redirectTo({ url: routes.home });
      } catch (error) {
        this.setData({ feedback: error.message });
      } finally {
        this.setData({ busy: false });
      }
    },
    openEmployee() {
      if (this.data.formal) wx.reLaunch({ url: '/pages/login/index' });
      else wx.navigateTo({ url: '/owner-login/pages/employee/index' });
    },
    enterInvite() {
      if (!this.data.formal || !this.data.live || this.data.busy) return;
      wx.showModal({
        title: '填写邀请口令',
        editable: true,
        placeholderText: '粘贴春茉提供的一次性邀请口令',
        success: (result) => {
          if (!result.confirm) return;
          const invite = String(result.content ?? '').trim();
          if (!invitePattern.test(invite)) {
            this.setData({ feedback: '请核对完整的邀请口令' });
            return;
          }
          this.setData({ invite, inviteReady: true, feedback: '' });
        },
      });
    },
    showPolicy,
  }),
);
