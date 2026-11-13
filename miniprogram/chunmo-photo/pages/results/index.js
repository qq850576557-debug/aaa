const { requireSession, enableAlbum } = require('../../lib/session');
const { fresh } = require('../../lib/location');
const { call, message } = require('../../lib/platform');
const { snapshot } = require('../../lib/metrics');
const labels = {
  capturing: '拍摄未完成',
  raw: '正在生成',
  ready: '待存相册',
  saving: '正在保存',
  saved: '相册已保存',
  failed: '处理失败',
  unknown: '请核对相册',
};
Page({
  app: null,
  engine: null,
  selected: new Map(),
  render: null,
  unsubscribe: null,
  data: {
    photos: [],
    recover: false,
    selectedCount: 0,
    allSelected: true,
    busy: false,
    stats: {},
    notice: '',
    warning: '',
    privacyVisible: false,
  },
  onLoad(options) {
    this.app = requireSession();
    if (!this.app) return;
    this.engine = this.app.engine;
    this.selected = new Map();
    this.setData({ recover: options.recover === '1', warning: this.app.store.warnings.join('；') });
    this.unsubscribe = this.engine.subscribe(() => this.refresh());
  },
  onReady() {
    if (!this.engine) return;
    const component = this.selectComponent('#renderer');
    this.render = (task) => component.render(task);
    this.engine.start(this.render);
  },
  onShow() {
    if (this.engine) {
      this.engine.active = true;
      this.engine.kick();
    }
  },
  onUnload() {
    if (this.unsubscribe) this.unsubscribe();
    if (this.engine && this.engine.renderer === this.render) this.engine.renderer = null;
  },
  refresh() {
    if (!this.engine) return;
    const scope = this.data.recover ? null : new Set(this.app.captureIds || []);
    const all = this.engine
      .list()
      .filter((t) => t.stage !== 'cancelled' && (!scope || scope.has(t.id)));
    const photos = all.map((t) => {
      if (!this.selected.has(t.id)) this.selected.set(t.id, true);
      return {
        id: t.id,
        selected: this.selected.get(t.id),
        label: this.engine.uncertain.has(t.id) ? '请核对相册' : labels[t.stage] || '待处理',
        thumbnail: t.thumbnailReady ? t.dir + '/thumb.jpg' : '',
        dimensions: t.outputWidth
          ? '原图 ' +
            t.rawWidth +
            '×' +
            t.rawHeight +
            ' → 成品 ' +
            t.outputWidth +
            '×' +
            t.outputHeight
          : '',
      };
    });
    this.setData({
      photos,
      selectedCount: photos.filter((p) => p.selected).length,
      allSelected: photos.length > 0 && photos.every((p) => p.selected),
      stats: {
        captured: all.filter((t) => t.stage !== 'capturing').length,
        saved: all.filter((t) => t.stage === 'saved').length,
        failed: all.filter(
          (t) => ['failed', 'unknown'].includes(t.stage) || this.engine.uncertain.has(t.id),
        ).length,
      },
      notice: this.engine.lastError || this.data.notice,
    });
  },
  toggle(e) {
    if (this.data.busy) return;
    const id = e.currentTarget.dataset.id;
    this.selected.set(id, !this.selected.get(id));
    this.refresh();
  },
  toggleAll() {
    if (this.data.busy) return;
    this.data.photos.forEach((p) => this.selected.set(p.id, !this.data.allSelected));
    this.refresh();
  },
  async saveIds(ids) {
    if (this.data.busy) return;
    this.setData({ busy: true, notice: '' });
    try {
      this.engine.autoSave = false;
      await enableAlbum(this.engine, false);
      // Pause automatic selection: this button saves exactly these IDs. Rendering
      // remains serial, and already confirmed successes are never saved again.
      this.engine.autoSave = false;
      if (this.engine.running) await this.engine.running;
      for (const id of ids) {
        let task = this.app.store.tasks.get(id);
        if (!task || task.deleted || task.stage === 'saved') continue;
        const volatile = this.app.volatilePhotos && this.app.volatilePhotos.get(id);
        if (volatile) {
          if (volatile.patch) await this.app.store.update(id, volatile.patch);
          await this.app.store.persistRaw(id, volatile.path);
          this.app.volatilePhotos.delete(id);
          task = this.app.store.tasks.get(id);
        }
        if (task.stage === 'unknown' || task.stage === 'saving' || this.engine.uncertain.has(id)) {
          const answer = await call('showModal', {
            title: '请先核对系统相册',
            content: '此照片上次保存结果不确定。确认相册中尚未保存，才重新保存，避免重复。',
            confirmText: '尚未保存',
            cancelText: '暂不重试',
          });
          if (!answer.confirm) continue;
          await this.engine.retry(id, true);
        } else if (task.stage === 'failed') await this.engine.retry(id);
        task = this.app.store.tasks.get(id);
        if (task.stage === 'capturing')
          throw Error('此照片未取得完整文件，请联系负责人检查本机暂存');
        await this.engine.kick();
        // Use the same per-photo state machine and receipt journal without
        // accidentally enabling saving for unrelated / unselected older photos.
        await this.engine.saveOnly(id);
        task = this.app.store.tasks.get(id);
        if (task.stage !== 'saved') {
          this.setData({
            notice: task.error || this.engine.lastError || '保存未完成，请核对相册后重试',
          });
          break;
        }
      }
      const confirmed = ids.filter((id) => this.app.store.tasks.get(id)?.stage === 'saved').length;
      if (confirmed === ids.length)
        this.setData({
          notice: '选中的' + confirmed + '张照片均已取得相册保存回执，已保存的照片不会重复写入。',
        });
      this.refresh();
    } catch (error) {
      this.setData({ notice: message(error) });
    } finally {
      this.engine.autoSave = false;
      this.setData({ busy: false });
      this.refresh();
    }
  },
  saveSelected() {
    return this.saveIds(this.data.photos.filter((p) => p.selected).map((p) => p.id));
  },
  saveOne(e) {
    return this.saveIds([e.currentTarget.dataset.id]);
  },
  permissionChanged() {
    this.setData({ notice: '权限已更新，可点击保存重试' });
  },
  async clearSelected() {
    if (this.data.busy) return;
    const ids = this.data.photos.filter((p) => p.selected).map((p) => p.id);
    if (!ids.length) return;
    const choice = await call('showModal', {
      title: '删除本机暂存',
      content: '仅删除选中的' + ids.length + '张本机照片。请先确认需要的照片已在系统相册中。',
      confirmColor: '#9f4033',
    });
    if (!choice.confirm) return;
    this.setData({ busy: true });
    this.engine.autoSave = false;
    try {
      if (this.engine.running) await this.engine.running;
      for (const id of ids) await this.app.store.remove(id);
      this.refresh();
    } catch (error) {
      this.setData({ notice: message(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async continueCapture() {
    if (this.data.busy) return;
    if (this.engine.running) await this.engine.running;
    this.engine.autoSave = false;
    try {
      await enableAlbum(this.engine);
    } catch {
      /* still permit durable local capture */
    }
    const url = fresh(this.app.place) ? '/pages/camera/index' : '/pages/places/index';
    wx.redirectTo({ url });
  },
  diagnostics() {
    call('setClipboardData', {
      data: JSON.stringify({ version: '1.2.1', metrics: snapshot() }),
    }).catch((error) => this.setData({ notice: message(error) }));
  },
});
