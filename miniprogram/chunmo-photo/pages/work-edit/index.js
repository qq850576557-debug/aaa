const { requireSession } = require('../../lib/session');
const { client, uuid } = require('../../lib/workbench-client');
const {
  purchaseStatuses,
  editableRecordStatuses,
  recordData,
  shanghaiDay,
} = require('../../lib/shared-workbench');
const { call, message } = require('../../lib/platform');
Page({
  data: {
    kind: 'record',
    form: {},
    projects: [],
    projectIndex: 0,
    statuses: [],
    statusIndex: 0,
    busy: false,
    error: '',
    history: [],
    privacyVisible: false,
  },
  async onLoad(options) {
    this.app = requireSession();
    if (!this.app) return;
    this.setData({ busy: true });
    try {
      this.client = client(this.app);
      if (!this.client.state) await this.client.refresh();
      const draft = options.recover === '1' ? this.client.draft : null;
      this.kind = draft?.kind || (options.kind === 'purchase' ? 'purchase' : 'record');
      this.id = draft?.id || options.id || '';
      this.base = this.client.state;
      this.old =
        this.kind === 'purchase'
          ? this.base.data.purchases.find((p) => p.id === this.id)
          : this.client.records.find((r) => r.id === this.id);
      if (this.id && !this.old && !draft) throw Error('记录不存在或已删除，请返回刷新');
      this.baseResource =
        draft?.baseResource ||
        (this.old && this.kind === 'purchase'
          ? {
              before: this.old,
              proof: this.base.resourceProofs[JSON.stringify(['purchases', 'record', this.id])],
              revision: this.base.revision,
            }
          : null);
      if (draft?.old && this.kind === 'record') this.old = draft.old;
      const source =
        draft?.form ||
        (this.old
          ? this.kind === 'record'
            ? recordData(this.old)
            : {
                ...this.old,
                due:
                  require('../../lib/shared-workbench')
                    .workbenchView(this.base.data, [], this.client.actor)
                    .items.find((i) => i.id === this.id)?.date || this.old.due,
              }
          : null);
      const projects = [...this.base.data.projects];
      if (source?.projectId && !projects.some((p) => p.id === source.projectId))
        projects.push({ id: source.projectId, name: this.old?.projectName || '历史工地' });
      const form = {
        projectId: projects[0]?.id || '',
        title: '',
        name: '',
        nodeDate: shanghaiDay(),
        due: shanghaiDay(),
        status: this.kind === 'record' ? '持续跟进' : '待采购',
        owner: '',
        notes: '',
        followUp: '',
        quantity: '',
        specification: '',
        ...source,
      };
      let statuses = this.kind === 'purchase' ? [...purchaseStatuses] : [...editableRecordStatuses];
      if (!statuses.includes(form.status)) statuses = [form.status, ...statuses];
      this.setData({
        kind: this.kind,
        form,
        projects,
        projectIndex: Math.max(
          0,
          projects.findIndex((p) => p.id === form.projectId),
        ),
        statuses,
        statusIndex: statuses.indexOf(form.status),
        error: draft ? '已恢复本机草稿；仍使用原版本校验，请核对后提交' : '',
      });
      this.ready = true;
      if (this.kind === 'record' && this.id) {
        try {
          const h = await this.app.api.request('workbench/records/' + this.id + '/history');
          this.setData({
            history: h.events.map((e) => ({
              at: e.at,
              actorName: e.actorName,
              operation: e.operation,
              fields: e.changedFields.join('、'),
            })),
          });
        } catch (e) {
          this.setData({ error: message(e) });
        }
      }
    } catch (e) {
      this.setData({ error: message(e) });
    } finally {
      this.setData({ busy: false });
    }
  },
  draft(form) {
    this.client.saveDraft({
      kind: this.kind,
      id: this.id,
      form,
      old: this.kind === 'record' ? this.old : null,
      baseResource: this.baseResource,
    });
  },
  field(e) {
    const form = { ...this.data.form, [e.currentTarget.dataset.field]: e.detail.value };
    this.setData({ form });
    try {
      this.draft(form);
    } catch (e) {
      this.setData({ error: message(e) + '；未同步，请保留当前页面' });
    }
  },
  project(e) {
    const projectIndex = Number(e.detail.value),
      p = this.data.projects[projectIndex];
    if (!p) return;
    const form = { ...this.data.form, projectId: p.id };
    this.setData({ projectIndex, form });
    try {
      this.draft(form);
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
  status(e) {
    const statusIndex = Number(e.detail.value),
      form = { ...this.data.form, status: this.data.statuses[statusIndex] };
    this.setData({ statusIndex, form });
    try {
      this.draft(form);
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
  async save() {
    if (this.data.busy || !this.ready) return;
    this.setData({ busy: true, error: '' });
    let queued = false;
    try {
      const f = this.data.form;
      this.draft(f);
      if (!f.projectId) throw Error('请选择所属工地');
      if (this.kind === 'purchase') {
        let base = this.base;
        if (this.baseResource)
          base = {
            ...base,
            revision: this.baseResource.revision,
            data: {
              ...base.data,
              purchases: [
                ...base.data.purchases.filter((p) => p.id !== this.id),
                this.baseResource.before,
              ],
            },
            resourceProofs: {
              ...base.resourceProofs,
              [JSON.stringify(['purchases', 'record', this.id])]: this.baseResource.proof,
            },
          };
        this.id = this.id || uuid();
        this.client.purchase(
          {
            projectId: f.projectId,
            name: f.name,
            due: f.due,
            status: f.status,
            quantity: f.quantity,
            specification: f.specification,
            owner: f.owner,
            notes: f.notes,
          },
          this.id,
          base,
        );
      } else
        this.client.record(
          {
            ...(this.old ? recordData(this.old) : {}),
            projectId: f.projectId,
            title: f.title,
            nodeDate: f.nodeDate,
            status: f.status,
            owner: f.owner,
            notes: f.notes,
            followUp: f.followUp,
          },
          this.old,
        );
      queued = true;
      await this.client.flush();
      await call('showToast', { title: '云端已确认', icon: 'success' });
      wx.navigateBack({ delta: 1 });
    } catch (e) {
      this.setData({ error: (queued ? '本机提交已保留：' : '') + message(e) });
      if (queued) {
        this.ready = false;
        await call('showModal', {
          title: '尚未确认云端保存',
          content: '提交已保存在本机。返回工作台可重试；发生冲突时核对草稿，不要重复新增。',
          showCancel: false,
        });
        wx.navigateBack({ delta: 1 });
      }
    } finally {
      this.setData({ busy: false });
    }
  },
});
