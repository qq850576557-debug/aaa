const store = require('../../fixture-store');
const owner = require('../../owner-session');
const { routes } = require('../../preview');
const domainMessage = '该链接的域名尚未配置为微信业务域名，请联系春茉核对。';
const invalidMessage = '设计成果链接格式不正确，请联系春茉更换链接。';
const previewMessage = '该链接是预览或编辑链接，请联系春茉更换为正式分享链接。';
const expiredMessage = '设计成果链接已失效，请联系春茉获取新链接。';
const loadMessage = '设计成果网页加载失败，请检查网络后重试。';
const shinewonderHost = '8ec387dc.shinewonder.com';

function viewerIssue(url) {
  const authority = /^https:\/\/([a-z0-9.-]+)(?::443)?(?=[/?#]|$)/i.exec(url);
  if (!authority || /[\s\\\u0000-\u001f\u007f]/u.test(url)) return invalidMessage;
  const host = authority[1].toLowerCase().replace(/\.$/, '');
  if (
    (host === 'shinewonder.com' || host.endsWith('.shinewonder.com')) &&
    authority[1].toLowerCase() !== shinewonderHost
  )
    return domainMessage;
  return '';
}

Page({
  data: { src: '', loading: true, feedback: '' },
  onLoad(options) {
    this.kind = ['rendering', 'panorama'].includes(options.kind) ? options.kind : '';
    this.project = typeof options.project === 'string' ? options.project : '';
    if (this.kind)
      wx.setNavigationBarTitle({ title: this.kind === 'rendering' ? '效果图' : '水电图' });
  },
  onShow() {
    return this.load();
  },
  onPullDownRefresh() {
    return this.load().finally(() => wx.stopPullDownRefresh());
  },
  onUnload() {
    this.epoch = (this.epoch || 0) + 1;
  },
  async load() {
    const epoch = (this.epoch = (this.epoch || 0) + 1);
    this.setData({ src: '', loading: true, feedback: '' });
    try {
      if (!store.isVerified() || !this.kind || store.snapshot().project?.id !== this.project) {
        this.setData({ feedback: '请从当前授权住宅打开设计成果' });
        return;
      }
      const result = await owner.projectDesign(this.project);
      if (epoch !== this.epoch) return;
      const url = result[this.kind];
      const issue = result[this.kind + 'Issue'];
      if (issue === 'domain_unconfigured') this.setData({ feedback: domainMessage });
      else if (issue === 'invalid_link') this.setData({ feedback: invalidMessage });
      else if (issue === 'preview_link') this.setData({ feedback: previewMessage });
      else if (!url)
        this.setData({
          feedback: result[this.kind + 'Unavailable']
            ? '此链接暂不能在微信内打开，请联系春茉'
            : '暂未发布',
        });
      else {
        const feedback = viewerIssue(url);
        this.setData(feedback ? { feedback } : { src: url });
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error.statusCode === 401) {
        store.end();
        wx.reLaunch({ url: routes.welcome });
      } else {
        this.setData({
          feedback:
            error.statusCode === 404
              ? '当前住宅的设计成果暂不可查看'
              : '设计成果加载失败，请稍后重试',
        });
      }
    } finally {
      if (epoch === this.epoch) this.setData({ loading: false });
    }
  },
  retry() {
    return this.load();
  },
  failed({ detail = {} } = {}) {
    if (!this.data.src) return;
    let feedback = loadMessage;
    const message = detail.errMsg || '';
    if (/业务域名|not in (?:the )?domain list|domain.*not allowed/i.test(message))
      feedback = domainMessage;
    else if (
      [404, 410].includes(Number(detail.statusCode)) ||
      /链接(?:已)?过期|链接已失效|share link (?:is )?expired/i.test(message)
    )
      feedback = expiredMessage;
    this.setData({ src: '', loading: false, feedback });
  },
});
