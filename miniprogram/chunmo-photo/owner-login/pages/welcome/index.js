const { withUi } = require('../../ui-tuning');
const { startPreview, routes, showPolicy } = require('../../preview');
const { begin, beginVerified, modes } = require('../../fixture-store');
const ownerSession = require('../../owner-session');
const unified = require('../../../lib/unified-login');
const { call } = require('../../../lib/platform');
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
      unified: false,
      roles: [],
      discoveredRoles: [],
      binding: '',
      ownerBinding: false,
      phoneBinding: false,
      staffLogin: '',
      password: '',
      inviteDraft: '',
      feedbackTone: 'info',
    },
    onLoad(options = {}) {
      if (ownerSession.unified()) {
        if (!startPreview(this, false)) return;
        const invite =
          typeof options.invite === 'string' && invitePattern.test(options.invite)
            ? options.invite
            : '';
        this.setData({ unified: true, formal: true, live: ownerSession.enabled(), invite });
        void this.restoreUnified(options);
        return;
      }
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
    async restoreUnified(options) {
      try {
        if (options.choose === '1') {
          this.setData({ agreed: true });
          // Explicit switch still verifies the current WeChat identity again.
          await this.discover(true);
          this.setData({ ready: true });
          return;
        }
        const owner = async () => {
          const session = await ownerSession.session();
          if (!session) return false;
          await this.enterOwner(session);
          return true;
        };
        const employee = async () => {
          const api = getApp().api;
          const identity =
            api.identity && api.cookie ? await api.restore() : await api.resumeRemembered();
          if (!identity) return false;
          await unified.staffHome(identity);
          return true;
        };
        if (!this.data.invite) {
          const attempts =
            wx.getStorageSync(unified.lastRole) === 'owner' ? [owner, employee] : [employee, owner];
          for (const attempt of attempts) {
            try {
              if (await attempt()) return;
            } catch (error) {
              if (![401, 403].includes(error.statusCode ?? error.status))
                this.setData({ feedback: error.message, feedbackTone: 'error' });
            }
          }
        }
      } catch (error) {
        this.setData({ feedback: error.message, feedbackTone: 'error' });
      }
      this.setData({ ready: true });
    },
    async enterOwner(value) {
      beginVerified(value);
      wx.setStorageSync(unified.lastRole, 'owner');
      const app = getApp();
      if (app.engine) app.engine.active = false;
      await call('redirectTo', { url: routes.home });
    },
    async discover(explicitSwitch = false, forceBind = false) {
      const { data } = await unified.exchange('discover');
      const roles = data.roles || [];
      unified.setDual(roles);
      this.setData({
        phoneBinding: data.phoneBinding,
        ownerBinding: data.ownerBinding,
        discoveredRoles: roles,
      });
      if (forceBind) {
        this.setData({
          binding: this.data.invite && data.ownerBinding ? 'owner' : 'employee',
          inviteDraft: this.data.invite,
        });
      } else if (this.data.invite && !roles.includes('owner') && data.ownerBinding) {
        this.setData({ binding: 'owner', inviteDraft: this.data.invite });
      } else if (roles.length === 2) {
        this.setData({ roles });
      } else if (roles.length === 1 && !explicitSwitch) {
        await this.enterRole(roles[0]);
      } else if (!roles.length && !explicitSwitch) {
        this.setData({ binding: 'employee' });
      } else {
        this.setData({ feedback: '当前微信仅有一个有效身份', feedbackTone: 'info' });
      }
    },
    async enterRole(role) {
      const result = await unified.exchange('enter', { role });
      if (result.data.role !== role) throw Error('登录身份校验失败，请重试');
      if (role === 'owner') return this.enterOwner(ownerSession.accept(result.data));
      const identity = await getApp().api.acceptWechat(result);
      await unified.staffHome(identity);
    },
    async pickRole(event) {
      if (this.data.busy || this.data.roles.length !== 2) return;
      this.setData({ busy: true, feedback: '' });
      try {
        await this.enterRole(event.currentTarget.dataset.role);
      } catch (error) {
        this.setData({ feedback: error.message, feedbackTone: 'error' });
      } finally {
        this.setData({ busy: false });
      }
    },
    showOwnerBinding() {
      this.setData({
        binding: 'owner',
        password: '',
        inviteDraft: this.data.invite || '',
        feedback: '',
      });
    },
    showEmployeeBinding() {
      this.setData({ binding: 'employee', feedback: '' });
    },
    closeBinding() {
      if (!this.data.busy) this.setData({ binding: '', roles: [], password: '', feedback: '' });
    },
    editBinding(event) {
      const key = event.currentTarget.dataset.field;
      const value = event.detail.value;
      if (['staffLogin', 'password', 'inviteDraft'].includes(key))
        this.setData({ [key]: value, feedback: '' });
    },
    async bindPhone(event) {
      if (this.data.busy || !this.data.agreed || !this.data.binding) return;
      const { code: phoneCode } = event.detail;
      if (!phoneCode) return this.setData({ feedback: '请授权手机号后重试', feedbackTone: 'info' });
      this.setData({ busy: true, feedback: '' });
      try {
        if (this.data.binding === 'owner') {
          if (!invitePattern.test(this.data.inviteDraft.trim()))
            throw Error('请核对完整的邀请口令');
          const value = await ownerSession.login(phoneCode, this.data.inviteDraft.trim());
          this.setData({ invite: '', inviteDraft: '' });
          unified.setDual([...this.data.discoveredRoles, 'owner']);
          await this.enterOwner(value);
        } else {
          const login = this.data.staffLogin.trim(),
            password = this.data.password;
          if (!login || !password) throw Error('请填写员工账号和密码');
          const result = await unified.exchange('bind-employee', { login, password, phoneCode });
          this.setData({ password: '' });
          unified.setDual([...this.data.discoveredRoles, 'employee']);
          const identity = await getApp().api.acceptWechat(result);
          await unified.staffHome(identity);
        }
      } catch (error) {
        this.setData({ password: '', feedback: error.message, feedbackTone: 'error' });
      } finally {
        this.setData({ busy: false });
      }
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
      if (this.data.unified) {
        if (!this.data.agreed) {
          this.setData({ feedback: '请先阅读并勾选协议及隐私指引', feedbackTone: 'info' });
          return;
        }
        this.setData({ busy: true, feedback: '' });
        return this.discover()
          .catch((error) => {
            this.setData({ feedback: error.message, feedbackTone: 'error' });
          })
          .finally(() => this.setData({ busy: false }));
      }
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
    async openEmployee() {
      if (this.data.unified) {
        if (this.data.busy) return;
        try {
          const result = await call('showActionSheet', {
            itemList: ['员工账号密码登录', '首次绑定'],
          });
          if (result.tapIndex === 0) wx.navigateTo({ url: '/pages/login/index?manual=1' });
          if (result.tapIndex === 1) {
            if (!this.data.agreed) {
              this.setData({ feedback: '请先阅读并勾选协议及隐私指引', feedbackTone: 'info' });
              return;
            }
            this.setData({ busy: true, feedback: '' });
            await this.discover(false, true);
          }
        } catch (error) {
          if (!/cancel/i.test(error.errMsg ?? ''))
            this.setData({
              feedback: error.message || '暂时无法打开，请重试。',
              feedbackTone: 'error',
            });
        } finally {
          this.setData({ busy: false });
        }
        return;
      }
      if (this.data.formal) wx.reLaunch({ url: '/pages/login/index?manual=1' });
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
