const store = require('../../fixture-store');
const owner = require('../../owner-session');
const { routes } = require('../../preview');

Page({
  data: { src: '', loading: true, feedback: '' },
  onLoad(options) {
    this.kind = ['rendering', 'panorama'].includes(options.kind) ? options.kind : '';
    this.project = typeof options.project === 'string' ? options.project : '';
    if (this.kind)
      wx.setNavigationBarTitle({ title: this.kind === 'rendering' ? '效果图' : '全景图' });
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
      if (!url)
        this.setData({
          feedback: result[this.kind + 'Unavailable']
            ? '此链接暂不能在微信内打开，请联系春茉'
            : '暂未发布',
        });
      else if (/^https:\/\/[a-z0-9.-]+\//i.test(url) && !/[\s\\]/u.test(url))
        this.setData({ src: url });
      else this.setData({ feedback: '链接与微信业务域名配置不一致，请联系春茉' });
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
  failed() {
    this.setData({
      src: '',
      loading: false,
      feedback: '内容加载失败，请检查网络；如反复失败，请联系春茉核对微信业务域名。',
    });
  },
});
