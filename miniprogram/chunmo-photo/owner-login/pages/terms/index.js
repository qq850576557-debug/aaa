const { startPreview, back } = require('../../preview');
const { terms } = require('../../owner-session');

Page({
  data: { ready: false, statusTop: 24, version: '', text: '' },
  onLoad() {
    if (!startPreview(this)) return;
    const policy = terms();
    if (policy) this.setData({ version: policy.version, text: policy.text });
  },
  back() {
    back('welcome');
  },
});
