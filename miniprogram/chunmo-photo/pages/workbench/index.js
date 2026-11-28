const { requireSession, clearEmployeeViews } = require('../../lib/session');
const { client } = require('../../lib/workbench-client');
const { workbenchView } = require('../../lib/shared-workbench');
const { setChanged } = require('../../lib/page-data');
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
      if (this.visible && e.isConnected) this.reload();
    };
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(this.network);
  },
  onShow() {
    this.visible = true;
    const app = requireSession();
    if (!app) return this.clearWorkspace();
    let current;
    try {
      current = client(app);
    } catch (e) {
      this.setData({ error: message(e) });
      return;
    }
    if (this.client !== current) {
      this.clearWorkspace();
      this.client = current;
    }
    this.render();
    if (
      this.foreground !== app.foreground ||
      !this.lastRead ||
      Date.now() - this.lastRead >= 1500 ||
      this.client.pending.length ||
      this.client.statusChanged
    )
      return this.reload();
  },
  onHide() {
    this.visible = false;
  },
  onUnload() {
    this.visible = false;
    this.client = null;
    if (wx.offNetworkStatusChange && this.network) wx.offNetworkStatusChange(this.network);
  },
  clearWorkspace() {
    if (this.client) {
      this.client.state = null;
      this.client.records = [];
    }
    this.client = null;
    this.lastRead = 0;
    this.setData({
      items: [],
      projects: [],
      pending: [],
      counts: {},
      projectId: '',
      projectIndex: 0,
      busy: false,
    });
  },
  async onPullDownRefresh() {
    try {
      await this.reload();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  reload() {
    const current = this.client;
    if (!current) return;
    if (this.reading?.client === current) return this.reading.promise;
    const foreground = getApp().foreground;
    const initial = !current.state;
    if (initial) setChanged(this, { busy: true, error: '' });
    const promise = (async () => {
      let failure;
      const changed = current.statusChanged || current.pending.length > 0;
      try {
        await current.flush();
      } catch (error) {
        failure = error;
      }
      try {
        await current.refresh(changed);
      } catch (error) {
        failure = error;
        if (
          this.client === current &&
          (error.status === 401 ||
            error.status === 403 ||
            error.code === 'OWNER_CHANGED' ||
            !getApp().api.identity)
        ) {
          if (getApp().workbench === current) clearEmployeeViews(getApp());
          this.clearWorkspace();
          if (this.visible) wx.reLaunch({ url: '/owner-login/pages/welcome/index' });
        }
      } finally {
        if (this.client === current) {
          this.foreground = foreground;
          this.lastRead = Date.now();
          setChanged(this, { busy: false, error: failure ? message(failure) : '' });
          this.render();
        }
        if (this.reading?.client === current) this.reading = null;
      }
    })();
    this.reading = { client: current, promise };
    return promise;
  },
  render() {
    const c = this.client;
    if (!c) return;
    setChanged(this, {
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
    setChanged(this, {
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
      wx.showToast({ title: '当前账号暂无表单草稿', icon: 'none', duration: 1400 });
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
