const { requireSession, enableAlbum } = require('../../lib/session');
const { locate, fresh, mergePlaces, renew } = require('../../lib/location');
const { call, message, privacy } = require('../../lib/platform');
Page({
  app: null,
  location: null,
  sequence: 0,
  page: 0,
  searchTimer: null,
  closed: false,
  data: {
    places: [],
    query: '',
    selectedId: '',
    busy: false,
    entering: false,
    more: false,
    status: '正在定位',
    error: '',
    accountName: '',
    privacyVisible: false,
  },
  onLoad() {
    this.app = requireSession();
    if (!this.app) return;
    this.setData({ accountName: this.app.api.identity.name });
    this.sequence = 0;
    this.page = 0;
    this.relocate();
  },
  onUnload() {
    clearTimeout(this.searchTimer);
    this.sequence++;
    this.closed = true;
  },
  queryInput(e) {
    this.setData({ query: e.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.search(), 500);
  },
  search() {
    this.fetchPlaces(false);
  },
  loadMore() {
    if (!this.data.busy && this.data.more) this.fetchPlaces(true);
  },
  settingsChanged() {
    this.relocate();
  },
  async relocate() {
    const seq = ++this.sequence;
    this.location = null;
    this.setData({ busy: true, selectedId: '', places: [], error: '', status: '正在获取实时定位' });
    try {
      const location = await locate();
      if (this.closed || seq !== this.sequence) return;
      this.location = location;
      this.setData({ status: '定位精度约±' + Math.round(location.accuracy) + '米' });
      await this.fetchPlaces(false);
    } catch (error) {
      if (!this.closed && seq === this.sequence)
        this.setData({ busy: false, error: message(error), status: '定位未获取' });
    }
  },
  async fetchPlaces(append) {
    if (!this.location) return;
    const seq = ++this.sequence,
      query = this.data.query.trim();
    let page = append ? this.page + 1 : 1;
    this.setData({ busy: true, error: '', ...(append ? {} : { places: [], selectedId: '' }) });
    try {
      if (Date.now() - Date.parse(this.location.obtainedAt) > 75000) {
        this.location = await locate();
        append = false;
        page = 1;
        if (seq !== this.sequence || this.closed) return;
        this.setData({
          places: [],
          selectedId: '',
          status: '定位精度约±' + Math.round(this.location.accuracy) + '米',
        });
      }
      const result = await this.app.api.request('nearby', {
        location: this.location,
        nearby: true,
        query,
        page,
      });
      if (this.closed || seq !== this.sequence) return;
      const places = mergePlaces(append ? this.data.places : [], result.places || []);
      const selected = places.find((p) => p.id === this.data.selectedId) || places[0];
      this.page = page;
      this.setData({ places, selectedId: selected ? selected.id : '', more: result.more === true });
    } catch (error) {
      if (!this.closed && seq === this.sequence) this.setData({ error: message(error) });
    } finally {
      if (!this.closed && seq === this.sequence) this.setData({ busy: false });
    }
  },
  select(e) {
    if (this.data.places.some((p) => p.id === e.currentTarget.dataset.id))
      this.setData({ selectedId: e.currentTarget.dataset.id });
  },
  async confirm() {
    if (this.data.entering) return;
    if (!requireSession()) return;
    const selected = this.data.places.find((p) => p.id === this.data.selectedId);
    if (!selected) return;
    this.setData({ entering: true, error: '' });
    try {
      let place = selected.receipt;
      if (!fresh(place)) place = await renew(this.app.api, place);
      if (!fresh(place)) throw Error('地点凭据已失效，请重新选择');
      await privacy();
      await call('authorize', { scope: 'scope.camera' });
      try {
        await enableAlbum(this.app.engine);
      } catch {
        this.app.engine.autoSave = false;
      }
      this.app.place = place;
      this.app.captureIds = [];
      await call('navigateTo', { url: '/pages/camera/index' });
    } catch (error) {
      this.setData({ error: message(error) });
    } finally {
      this.setData({ entering: false });
    }
  },
  results() {
    wx.navigateTo({ url: '/pages/results/index?recover=1' });
  },
  async logout() {
    const choice = await call('showModal', {
      title: '退出账号',
      content: '本机照片继续保留，下次登录同一账号可恢复。',
    });
    if (!choice.confirm) return;
    if (this.app.engine) {
      this.app.engine.active = false;
      if (this.app.engine.running) await this.app.engine.running;
    }
    try {
      await this.app.api.logout();
    } catch {
      /* credentials cleared even if offline */
    }
    wx.reLaunch({ url: '/pages/login/index' });
  },
});
