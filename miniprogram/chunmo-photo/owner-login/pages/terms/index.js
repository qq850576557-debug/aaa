const { startPreview, back, showPolicy } = require('../../preview');
const { terms, privacyPolicy } = require('../../owner-session');

Page({
  data: { ready: false, statusTop: 24, title: '用户服务协议', version: '', text: '', privacy: false },
  onLoad(options = {}) {
    if (!startPreview(this)) return;
    const privacy = options.type === 'privacy';
    const policy = privacy ? privacyPolicy() : terms();
    this.setData({
      title: privacy ? '隐私政策' : '用户服务协议',
      version: policy?.version || '',
      text: policy?.text || '',
      privacy,
    });
  },
  showPolicy,
  back() {
    back('welcome');
  },
});
