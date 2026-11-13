const { requireSession } = require('../../lib/session');
const { fresh, renew } = require('../../lib/location');
const { call, message, safeTop } = require('../../lib/platform');
const { layout } = require('../../lib/watermark');
const { record } = require('../../lib/metrics');
Page({
  app: null,
  engine: null,
  context: null,
  render: null,
  unsubscribe: null,
  ids: [],
  started: 0,
  hidden: false,
  closed: false,
  renewing: false,
  clock: null,
  lease: null,
  volatile: null,
  cameraIssue: '',
  data: {
    mounted: true,
    ready: false,
    capturing: false,
    blocked: false,
    finishing: false,
    captured: 0,
    saved: 0,
    failed: 0,
    placeName: '',
    notice: '',
    lines: [],
    wm: {},
    top: 60,
    privacyVisible: false,
  },
  onLoad() {
    this.app = requireSession();
    if (!this.app) return;
    if (!this.app.place) {
      wx.redirectTo({ url: '/pages/places/index' });
      return;
    }
    this.engine = this.app.engine;
    this.started = Date.now();
    this.ids = this.app.captureIds || [];
    this.setData({ placeName: this.app.place.placeName });
    this.updateGeometry();
    this.unsubscribe = this.engine.subscribe(() => this.refresh());
  },
  onReady() {
    if (!this.app || !this.engine) return;
    this.context = wx.createCameraContext();
    const component = this.selectComponent('#renderer');
    this.render = (task) => component.render(task);
    this.engine.start(this.render);
  },
  onShow() {
    if (!this.app || !this.engine) return;
    this.hidden = false;
    if (this.context && !this.data.ready) this.cameraIssue = '相机已暂停，点击继续取景';
    this.engine.active = true;
    this.clock = setInterval(() => this.updateGeometry(), 15000);
    this.lease = setInterval(() => this.refreshLease(), 60000);
    this.refreshLease();
    this.engine.kick();
  },
  onHide() {
    this.hidden = true;
    clearInterval(this.clock);
    clearInterval(this.lease);
    this.setData({ ready: false });
  },
  onUnload() {
    this.closed = true;
    clearInterval(this.clock);
    clearInterval(this.lease);
    if (this.unsubscribe) this.unsubscribe();
    if (this.engine && this.engine.renderer === this.render) this.engine.renderer = null;
  },
  onResize() {
    this.updateGeometry();
  },
  updateGeometry() {
    if (!this.app || !this.app.api.identity || this.closed) return;
    const window = safeTop(),
      task = {
        place: this.app.place,
        capturedAt: new Date().toISOString(),
        actorName: this.app.api.identity.name,
      };
    // Preview uses the same typography/line wrapping. Its native camera viewport
    // may crop on some phones; final output always uses the complete still photo.
    const l = layout(window.windowWidth, window.windowHeight, task);
    this.setData({
      top: window.top,
      lines: l.lines,
      wm: {
        x: l.x,
        bottom: window.windowWidth > window.windowHeight ? 16 : 148,
        width: l.boxW,
        pad: l.pad,
        radius: 14 * l.scale,
        logo: l.logoSize,
        brand: l.brandFont,
        font: l.font,
        gap: l.gap,
      },
    });
  },
  cameraReady() {
    if (this.closed || this.hidden) return;
    this.setData({ ready: true });
    this.cameraIssue = '';
    record('camera-init', this.started);
    this.refresh();
  },
  cameraError(e) {
    this.cameraIssue = '相机不可用：' + message(e.detail) + '；点击重试';
    this.setData({ ready: false, notice: this.cameraIssue });
  },
  cameraStopped() {
    this.cameraIssue = '相机已暂停，点击继续取景';
    if (!this.closed) this.setData({ ready: false, notice: this.cameraIssue });
  },
  refresh() {
    if (!this.engine || this.closed) return;
    const tasks = this.engine.list().filter((t) => this.ids.includes(t.id));
    const captured = tasks.filter((t) => !['capturing', 'cancelled'].includes(t.stage)).length;
    const saved = tasks.filter((t) => t.stage === 'saved').length;
    const failed = tasks.filter(
      (t) => ['failed', 'unknown'].includes(t.stage) || this.engine.uncertain.has(t.id),
    ).length;
    const backlog = this.engine.list().filter((t) => t.stage === 'raw').length;
    this.setData({
      captured,
      saved,
      failed,
      blocked: !!this.volatile || backlog >= 4 || !fresh(this.app.place) || !this.app.api.identity,
    });
    if (this.volatile) this.setData({ notice: '本机暂存失败，请勿退出；点击重试保留此照片' });
    else if (!this.app.api.identity)
      this.setData({ notice: '登录已失效，本机照片保留；点击重新登录' });
    else if (this.cameraIssue) this.setData({ notice: this.cameraIssue });
    else if (this.engine.lastError) this.setData({ notice: this.engine.lastError });
    else if (!this.engine.autoSave)
      this.setData({ notice: '照片保留在本机，完成后可授权保存相册' });
    else if (this.data.ready && fresh(this.app.place))
      this.setData({ notice: backlog >= 4 ? '正在处理照片，请稍候' : '' });
  },
  async refreshLease() {
    if (this.renewing || this.hidden || this.closed || !this.app) return;
    if (!this.app.api.identity) {
      this.refresh();
      return;
    }
    if (fresh(this.app.place) && Date.parse(this.app.place.expiresAt) - Date.now() > 30000) {
      this.refresh();
      return;
    }
    this.renewing = true;
    const previous = this.app.place;
    try {
      const next = await renew(this.app.api, previous);
      if (!this.closed && !this.hidden && previous === this.app.place) this.app.place = next;
    } catch (error) {
      if (!this.closed) this.setData({ notice: message(error) + '；点击重新定位', blocked: true });
    } finally {
      this.renewing = false;
      this.refresh();
    }
  },
  async capture() {
    if (!this.data.ready || this.data.capturing || this.data.blocked || this.data.finishing) return;
    if (!fresh(this.app.place)) {
      this.setData({ blocked: true });
      this.refreshLease();
      return;
    }
    const started = Date.now(),
      place = JSON.parse(JSON.stringify(this.app.place));
    const capturedAt = new Date().toISOString();
    this.setData({ capturing: true });
    let task;
    try {
      task = await this.app.store.reserve(place, capturedAt);
      this.ids.push(task.id);
      this.app.captureIds = this.ids;
      if (!fresh(place)) {
        this.refreshLease();
        throw Error('定位凭据已过期，重新定位后再拍摄');
      }
      const photo = await new Promise((resolve, reject) =>
        this.context.takePhoto({
          quality: 'original',
          selfieMirror: false,
          success: resolve,
          fail: reject,
        }),
      );
      record('camera-file', started);
      this.volatile = { id: task.id, path: photo.tempImagePath };
      if (this.app.volatilePhotos) this.app.volatilePhotos.set(task.id, this.volatile);
      await this.persistVolatile();
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail() {} });
    } catch (error) {
      if (task && !this.volatile && this.app.store.tasks.get(task.id)?.stage === 'capturing')
        try {
          await this.app.store.update(task.id, { stage: 'cancelled', error: message(error) });
        } catch {
          /* journal retained */
        }
      this.setData({ notice: message(error) });
    } finally {
      this.setData({ capturing: false });
      this.refresh();
    }
  },
  async persistVolatile() {
    const current = this.volatile;
    if (!current) return;
    const started = Date.now();
    await this.app.store.persistRaw(current.id, current.path);
    if (this.app.volatilePhotos) this.app.volatilePhotos.delete(current.id);
    this.volatile = null;
    record('raw-durable', started);
    this.engine.emit();
    this.engine.kick();
  },
  async noticeTap() {
    if (this.volatile) {
      try {
        await this.persistVolatile();
        this.refresh();
      } catch (error) {
        this.setData({ notice: message(error) + '；请勿退出，点击重试' });
      }
    } else if (!this.app.api.identity) {
      if (this.data.capturing) return;
      this.engine.active = false;
      if (this.engine.running) await this.engine.running;
      wx.reLaunch({ url: '/pages/login/index' });
    } else if (!fresh(this.app.place)) this.refreshLease();
    else if (!this.data.ready) {
      this.started = Date.now();
      this.setData({ mounted: false });
      wx.nextTick(() => this.setData({ mounted: true, notice: '正在启动相机' }));
    }
  },
  async finish() {
    if (this.data.finishing || this.data.capturing) return;
    if (this.volatile) {
      await this.noticeTap();
      if (this.volatile) return;
    }
    this.setData({ finishing: true, ready: false, notice: '正在准备照片' });
    await this.engine.kick();
    await call('redirectTo', { url: '/pages/results/index' }).catch((error) =>
      this.setData({ finishing: false, notice: message(error) }),
    );
  },
  async close() {
    if (this.data.capturing || this.data.finishing) return;
    if (this.volatile) {
      await this.noticeTap();
      if (this.volatile) return;
    }
    if (this.ids.length) return this.finish();
    wx.navigateBack({ delta: 1 });
  },
});
