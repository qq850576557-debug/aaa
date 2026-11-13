Component({
  properties: { show: Boolean },
  methods: {
    agree() {
      getApp().resolvePrivacy(true);
    },
    disagree() {
      getApp().resolvePrivacy(false);
    },
    contract() {
      wx.openPrivacyContract({
        fail: () => wx.showToast({ title: '请负责人先配置小程序隐私指引', icon: 'none' }),
      });
    },
  },
});
