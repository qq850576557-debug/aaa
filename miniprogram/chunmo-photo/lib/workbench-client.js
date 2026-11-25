const { planPurchase, planRecord, recordData } = require('./shared-workbench');
function uuid() {
  // A request identifier, never an authentication secret.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
class WorkbenchClient {
  constructor(api, storage) {
    this.api = api;
    this.storage = storage;
    this.actor = api.identity;
    this.key = 'chunmo-workbench-v1:' + this.actor.workspaceId + ':' + this.actor.id;
    const saved = storage.get(this.key);
    if (
      saved &&
      (!Array.isArray(saved.pending) ||
        saved.actor !== this.actor.id ||
        saved.workspace !== this.actor.workspaceId)
    )
      throw Error('本机工作草稿格式异常，未覆盖，请保留本机数据');
    this.pending = saved ? saved.pending : [];
    this.archive = saved ? saved.archive || [] : [];
    this.draft = saved ? saved.draft : null;
    this.drafts = saved
      ? saved.drafts ||
        (saved.draft ? { [saved.draft.kind + ':' + saved.draft.id]: saved.draft } : {})
      : {};
    this.state = null;
    this.records = [];
  }
  checkActor() {
    if (
      !this.api.identity ||
      this.api.identity.id !== this.actor.id ||
      this.api.identity.workspaceId !== this.actor.workspaceId
    )
      throw Error('账号已变化，原账号草稿保留，请重新登录');
  }
  persist(pending = this.pending, draft = this.draft) {
    this.checkActor();
    this.storage.set(this.key, {
      actor: this.actor.id,
      workspace: this.actor.workspaceId,
      pending,
      draft,
      archive: this.archive,
      drafts: this.drafts,
    });
    this.pending = pending;
    this.draft = draft;
  }
  saveDraft(value) {
    const previous = this.drafts;
    const next = { ...previous };
    if (value) next[value.kind + ':' + value.id] = value;
    else if (this.draft) delete next[this.draft.kind + ':' + this.draft.id];
    this.drafts = next;
    try {
      this.persist(this.pending, value);
    } catch (e) {
      this.drafts = previous;
      throw e;
    }
  }
  async refresh() {
    this.checkActor();
    const [state, result] = await Promise.all([
      this.api.request('workbench/workspace'),
      this.api.request('workbench/records'),
    ]);
    this.checkActor();
    if (!state.data || !state.resourceProofs || !Array.isArray(result.records))
      throw Error('工作台协议尚未就绪，未覆盖本机草稿');
    this.state = state;
    this.records = result.records;
  }
  enqueue(path, method, body, entity) {
    if (this.pending.some((p) => p.entity === entity))
      throw Error('该记录仍有待同步修改，请先处理原提交');
    const command = JSON.parse(JSON.stringify({ path, method, body, entity }));
    const previous = this.drafts;
    this.drafts = { ...previous };
    if (this.draft) delete this.drafts[this.draft.kind + ':' + this.draft.id];
    try {
      this.persist([...this.pending, command], null);
    } catch (e) {
      this.drafts = previous;
      throw e;
    }
    return command;
  }
  purchase(fields, id = uuid(), base = this.state) {
    if (!this.state) throw Error('请先读取采购数据');
    const body = planPurchase(base, fields, uuid(), id);
    if (!body.changes.length) {
      this.saveDraft(null);
      return;
    }
    this.enqueue('workbench/workspace', 'PUT', body, 'purchase:' + id);
  }
  record(value, old) {
    const body = planRecord(value, uuid(), old);
    this.enqueue(
      'workbench/records' + (old ? '/' + old.id : ''),
      old ? 'PUT' : 'POST',
      body,
      'record:' + (old ? old.id : body.requestId),
    );
  }
  archiveBlocked(index) {
    const item = this.pending[index];
    if (!item || !item.blocked) throw Error('仅可归档已明确失败的提交');
    const previous = this.archive;
    this.archive = [...previous, item];
    try {
      this.persist(this.pending.filter((p) => p !== item));
    } catch (e) {
      this.archive = previous;
      throw e;
    }
  }
  async flush() {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async drain() {
    this.checkActor();
    if (!this.pending.length) return;
    const session = await this.api.request('session');
    this.checkActor();
    if (
      !session.user ||
      session.user.id !== this.actor.id ||
      session.user.workspaceId !== this.actor.workspaceId
    )
      throw Error('登录会话不匹配，未提交本机修改');
    for (const item of [...this.pending]) {
      this.checkActor();
      if (item.blocked) throw Error(item.blocked);
      try {
        const result = await this.api.request(item.path, item.body, item.method);
        const confirmed =
          item.path === 'workbench/workspace'
            ? result &&
              Number.isInteger(result.revision) &&
              result.data &&
              Array.isArray(result.data.purchases)
            : result &&
              typeof result.id === 'string' &&
              Number.isInteger(result.version) &&
              result.version >= 1;
        if (!confirmed) throw Error('云端未返回有效保存回执，原提交已保留');
      } catch (error) {
        if ([400, 403, 404, 409, 422].includes(error.status)) {
          const reason =
            error.status === 409 ? '数据已变化，待同步草稿保留，请核对后重新编辑' : error.message;
          this.persist(this.pending.map((p) => (p === item ? { ...p, blocked: reason } : p)));
        }
        throw error;
      }
      // If writing this receipt fails, leave the same requestId on disk; a
      // retry must be handled by the existing server idempotency receipt.
      this.persist(this.pending.filter((p) => p !== item));
    }
  }
  recordValue(old) {
    return recordData(old);
  }
}
function client(app) {
  if (
    !app.workbench ||
    app.workbench.api !== app.api ||
    app.workbench.actor.id !== app.api.identity.id ||
    app.workbench.actor.workspaceId !== app.api.identity.workspaceId
  )
    app.workbench = new WorkbenchClient(app.api, {
      get: (key) => wx.getStorageSync(key),
      set: (key, value) => wx.setStorageSync(key, value),
    });
  return app.workbench;
}
module.exports = { WorkbenchClient, client, uuid };
