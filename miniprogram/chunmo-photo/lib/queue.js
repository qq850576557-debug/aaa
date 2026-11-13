const { record } = require('./metrics');
const { message } = require('./platform');
class PhotoQueue {
  constructor(store, saveImage) {
    this.store = store;
    this.saveImage = saveImage;
    this.renderer = null;
    this.active = true;
    this.autoSave = false;
    this.listeners = new Set();
    this.running = null;
    this.current = '';
    this.uncertain = new Set();
    this.explicitIds = new Set();
  }
  subscribe(fn) {
    this.listeners.add(fn);
    fn();
    return () => this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((fn) => fn());
  }
  list() {
    return this.store.list().filter((t) => !t.deleted);
  }
  stats() {
    const all = this.list().filter((t) => t.stage !== 'cancelled' && t.stage !== 'capturing');
    return {
      captured: all.length,
      saved: all.filter((t) => t.stage === 'saved').length,
      failed: all.filter((t) => ['failed', 'unknown'].includes(t.stage)).length,
      pending: all.filter((t) => ['raw', 'ready', 'saving'].includes(t.stage)).length,
    };
  }
  async start(renderer) {
    this.renderer = renderer;
    await this.kick();
  }
  kick() {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.current = '';
      this.emit();
    });
    return this.running;
  }
  async drain() {
    while (this.active) {
      const task = this.list().find(
        (t) =>
          !this.uncertain.has(t.id) &&
          ((t.stage === 'raw' && this.renderer) ||
            (t.stage === 'ready' && (this.autoSave || this.explicitIds.has(t.id)))),
      );
      if (!task) break;
      this.current = task.id;
      try {
        if (task.stage === 'raw') {
          const started = Date.now();
          const result = await this.renderer(task);
          await this.store.persistOutput(task.id, result);
          record('watermark-and-durable', started, { width: result.width, height: result.height });
        } else {
          await this.store.update(task.id, { stage: 'saving', error: '' });
          this.emit();
          const started = Date.now();
          try {
            await this.saveImage(task.dir + '/marked.jpg');
          } catch (error) {
            const reason = String(error.errMsg || error.message || '');
            // Permission rejection happens before media writing. Other errors can
            // be an ambiguous platform result: never automatically duplicate it.
            const permission = /auth deny|authorize|permission|privacy/i.test(reason);
            this.autoSave = false;
            this.explicitIds.delete(task.id);
            await this.store.update(task.id, {
              stage: permission ? 'ready' : 'unknown',
              error: message(error),
            });
            this.emit();
            continue;
          }
          try {
            await this.store.update(task.id, {
              stage: 'saved',
              error: '',
              albumConfirmedAt: new Date().toISOString(),
            });
          } catch (error) {
            this.uncertain.add(task.id);
            this.autoSave = false;
            // Memory guard prevents re-saving after the OS success if disk is full.
            this.lastError = '相册接口已返回成功，但本机记录写入失败；请先核对相册，勿重复保存';
            throw error;
          }
          record('album-receipt', started);
        }
      } catch (error) {
        const latest = this.store.tasks.get(task.id);
        this.lastError =
          this.uncertain.has(task.id) && latest.stage === 'saving'
            ? '相册接口已返回成功，但本机记录写入失败；请先核对相册，勿重复保存'
            : message(error);
        if (latest.stage === 'raw') {
          try {
            await this.store.update(task.id, { stage: 'failed', error: message(error) });
          } catch {
            this.uncertain.add(task.id);
          }
        } else this.uncertain.add(task.id);
      }
      this.emit();
    }
  }
  async retry(id, allowUncertain = false) {
    if (this.current === id && this.running) throw Error('此照片正在处理');
    const task = this.store.tasks.get(id);
    if (!task || task.deleted || task.stage === 'saved') return;
    if (
      (task.stage === 'unknown' || task.stage === 'saving' || this.uncertain.has(id)) &&
      !allowUncertain
    )
      throw Error('请先核对相册，确认尚未保存后再重试');
    // If an uncertain OS save has been checked by the user, preserve and reuse
    // the already composed full-size output; never re-stamp its capture time.
    const ready = task.outputBytes > 0 && (await this.store.exists(task.dir + '/marked.jpg'));
    await this.store.update(id, { stage: ready ? 'ready' : 'raw', error: '' });
    this.uncertain.delete(id);
    this.lastError = '';
    this.emit();
    return this.kick();
  }
  async saveOnly(id) {
    this.explicitIds.add(id);
    try {
      await this.kick();
    } finally {
      this.explicitIds.delete(id);
    }
  }
}
module.exports = { PhotoQueue };
