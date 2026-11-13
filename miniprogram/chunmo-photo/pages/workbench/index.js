const { requireSession } = require('../../lib/session');
const { client } = require('../../lib/workbench-client');
const { workbenchView, shanghaiDay } = require('../../lib/shared-workbench');
const { message, call } = require('../../lib/platform');
Page({
  data: {
    tab: 'today',
    tabs: ['今日', '明日', '逾期', '采购', '事项'],
    tabKeys: ['today', 'tomorrow', 'overdue', 'purchases', 'records'],
    projects: [],
    projectIndex: 0,
    projectId: '',
    mine: false,
    date: '',
    items: [],
    busy: false,
    error: '',
    pending: [],
    privacyVisible: false,
  },
  onLoad() {
    this.app = requireSession();
    if (!this.app) return;
    try {
      this.client = client(this.app);
    } catch (e) {
      this.setData({ error: message(e) });
    }
    this.network = (e) => {
      if (e.isConnected) this.reload();
    };
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(this.network);
  },
  onShow() {
    if (this.client) this.reload();
  },
  onUnload() {
    if (wx.offNetworkStatusChange && this.network) wx.offNetworkStatusChange(this.network);
  },
  async onPullDownRefresh() {
    await this.reload();
    wx.stopPullDownRefresh();
  },
  async reload() {
    if (!this.client || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await this.client.flush();
      await this.client.refresh();
    } catch (e) {
      this.setData({ error: message(e) });
      try {
        await this.client.refresh();
      } catch {}
    } finally {
      this.setData({ busy: false });
      this.render();
    }
  },
  render() {
    const c = this.client;
    if (!c) return;
    this.setData({
      pending: c.pending.map((p, index) => ({
        index,
        title: p.body.value?.title || p.body.changes?.[0]?.after?.name || '待同步记录',
        blocked: p.blocked || '',
      })),
    });
    if (!c.state) return;
    const v = workbenchView(c.state.data, c.records, c.actor);
    const projects = [{ id: '', name: '全部工地' }, ...c.state.data.projects];
    const projectIndex = Math.max(
      0,
      projects.findIndex((p) => p.id === this.data.projectId),
    );
    const project = projects[projectIndex].id;
    let items =
      this.data.tab === 'today'
        ? v.today
        : this.data.tab === 'tomorrow'
          ? v.tomorrowItems
          : this.data.tab === 'overdue'
            ? v.overdue
            : v.items.filter(
                (i) => i.kind === (this.data.tab === 'purchases' ? 'purchase' : 'record'),
              );
    items = items
      .filter(
        (i) =>
          (!project || i.projectId === project) &&
          (!this.data.mine || i.mine) &&
          (!this.data.date || i.date === this.data.date),
      )
      .map((i) => ({
        key: i.kind + ':' + i.id,
        id: i.id,
        kind: i.kind,
        title: i.title,
        projectName: i.projectName,
        date: i.date,
        status: i.status,
        owner: i.owner,
        done: i.done,
        remaining: i.remaining,
        remainingLabel:
          i.remaining === null
            ? ''
            : i.remaining < 0
              ? '逾期 ' + -i.remaining + ' 天'
              : i.remaining === 0
                ? '今日到期'
                : '剩余 ' + i.remaining + ' 天',
      }));
    this.setData({
      items,
      projects,
      projectIndex,
      day: v.day,
      counts: { today: v.today.length, tomorrow: v.tomorrowItems.length },
    });
  },
  tab(e) {
    this.setData({ tab: e.currentTarget.dataset.key, date: '' });
    this.render();
  },
  project(e) {
    const projectIndex = Number(e.detail.value);
    this.setData({ projectIndex, projectId: this.data.projects[projectIndex]?.id || '' });
    this.render();
  },
  mine(e) {
    this.setData({ mine: e.detail.value });
    this.render();
  },
  date(e) {
    this.setData({ date: e.detail.value });
    this.render();
  },
  clearDate() {
    this.setData({ date: '' });
    this.render();
  },
  edit(e) {
    wx.navigateTo({
      url:
        '/pages/work-edit/index?kind=' +
        e.currentTarget.dataset.kind +
        '&id=' +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
  },
  add() {
    wx.navigateTo({
      url: '/pages/work-edit/index?kind=' + (this.data.tab === 'purchases' ? 'purchase' : 'record'),
    });
  },
  async recoverDraft() {
    const drafts = Object.values(this.client.drafts);
    if (!drafts.length) {
      this.setData({ error: '当前账号暂无表单草稿' });
      return;
    }
    try {
      const a = await call('showActionSheet', {
        itemList: drafts
          .slice(0, 6)
          .map(
            (d) =>
              (d.kind === 'purchase' ? '采购：' : '事项：') +
              (d.form.name || d.form.title || '未命名'),
          ),
      });
      this.client.saveDraft(drafts[a.tapIndex]);
      wx.navigateTo({ url: '/pages/work-edit/index?recover=1' });
    } catch {}
  },
  async pending(e) {
    const index = Number(e.currentTarget.dataset.index),
      item = this.client.pending[index];
    if (!item) return;
    try {
      await call('setClipboardData', { data: JSON.stringify(item.body, null, 2) });
      if (!item.blocked) return;
      const answer = await call('showModal', {
        title: '原提交已复制',
        content:
          '该提交已被服务器拒绝。是否保留到本机归档，并重新打开对应记录核对？不会自动覆盖云端。',
        confirmText: '归档核对',
      });
      if (answer.confirm) {
        const id = item.entity.startsWith('purchase:')
          ? item.entity.slice(9)
          : item.path.split('/')[2];
        this.client.archiveBlocked(index);
        this.render();
        if (id)
          wx.navigateTo({
            url:
              '/pages/work-edit/index?kind=' +
              (item.entity.startsWith('purchase:') ? 'purchase' : 'record') +
              '&id=' +
              encodeURIComponent(id),
          });
      }
    } catch (e) {
      this.setData({ error: message(e) });
    }
  },
});
