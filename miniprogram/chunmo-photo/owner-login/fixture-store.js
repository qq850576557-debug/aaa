// The development pages keep an in-memory sample only. No WeChat code, cookie,
// local storage or network credentials are involved in this fixture store.
const { startPreview, routes } = require('./preview');
const reminders = require('./purchase-reminders');
const ownerSession = require('./owner-session');

const labels = { pending: '待采购', bought: '已下单', complete: '已到货' };
const blankFeedback = { brand: '', model: '', note: '' };
const modes = ['review', 'single', 'empty', 'offline', 'denied'];
let session = null;

const copy = (value) => JSON.parse(JSON.stringify(value));

function dateAt(offset, now) {
  return new Date(now + (8 + offset * 24) * 3600000).toISOString().slice(0, 10);
}

function begin(mode = 'review', now = Date.now()) {
  session = null;
  if (mode === 'denied') return false;
  const today = dateAt(0, now);
  const items = [
    {
      id: 'lighting',
      title: '客厅无主灯轨道灯',
      state: 'pending',
      due: dateAt(-1, now),
      description: '选购前请核对灯体长度与开孔尺寸，灯具颜色宜选哑光白。',
      specification: '3000K 暖白光，显色指数 Ra ≥ 90',
      quantity: '6 只',
    },
    {
      id: 'tiles',
      title: '主卫墙地砖',
      state: 'pending',
      due: dateAt(3, now),
      description: '选用同一色号和批次，地面选防滑哑光面。确认前请把实物样板留给现场核对。',
      specification: '600 × 1200 mm',
      quantity: '按实测面积复核',
    },
    {
      id: 'hardware',
      title: '餐边柜抽屉拉手及适配固定配件',
      state: 'pending',
      due: dateAt(8, now),
      description: '颜色与柜体实物样板核对，避免不同表面处理造成色差。',
      specification: '孔距 128 mm',
      quantity: '8 套',
    },
    {
      id: 'sink',
      title: '厨房水槽',
      state: 'bought',
      due: dateAt(2, now),
      description: '台下安装，水槽开孔尺寸以商品图纸为准。',
      specification: '不锈钢单槽',
      quantity: '1 套',
      feedback: { brand: '示例品牌', model: 'CM-720', note: '已核对台面开孔图。' },
    },
    {
      id: 'floor',
      title: '客卧木地板',
      state: 'complete',
      due: dateAt(-4, now),
      description: '公司已核对色号及用量。',
      specification: '浅橡木色，哑光面',
      quantity: '18 ㎡',
      feedback: { brand: '示例品牌', model: 'CM-OAK-18', note: '' },
    },
  ];
  const projects = [
    { id: 'demo-a', title: '云栖花园 · 演示住宅', phase: '施工中' },
    { id: 'demo-b', title: '梧桐公馆 · 演示住宅', phase: '筹备中' },
  ].slice(0, ['single', 'empty'].includes(mode) ? 1 : 2);
  const records = {
    'demo-a': mode === 'empty' ? [] : items,
    'demo-b': [{ ...items[1], id: 'tile-b', title: '次卫地砖', due: dateAt(9, now) }],
  };
  for (const list of Object.values(records)) {
    for (const item of list) {
      Object.assign(item, { feedback: { ...blankFeedback, ...item.feedback }, version: 1 });
    }
  }
  session = {
    owner: { name: '演示业主', avatar: '' },
    active: projects[0].id,
    projects,
    records,
    today,
    offline: mode === 'offline',
  };
  return true;
}

function beginVerified({ owner, projects, purchasesEnabled }) {
  if (!owner?.id || !Array.isArray(projects) || !projects.length)
    throw Error('暂无访问授权，请联系春茉');
  const sameOwner = session?.owner.id === owner.id;
  const active =
    sameOwner && projects.some(({ id }) => id === session.active) ? session.active : projects[0].id;
  const avatar = sameOwner ? session.owner.avatar : '';
  session = {
    owner: { id: owner.id, name: owner.name, avatar },
    active,
    projects,
    records: Object.fromEntries(projects.map(({ id }) => [id, []])),
    pendingFeedback: sameOwner ? session.pendingFeedback : new Map(),
    purchasesEnabled: purchasesEnabled === true,
    today: dateAt(0, Date.now()),
    offline: false,
    verified: true,
  };
}

function isVerified() {
  return session?.verified === true;
}

let refreshing;
function refreshVerified() {
  if (!isVerified()) return Promise.resolve();
  if (refreshing?.session === session) return refreshing.promise;
  const previous = session;
  const promise = (async () => {
    try {
      const result = await ownerSession.session();
      if (session !== previous) return;
      if (!result) throw Object.assign(Error('业主登录已失效，请重新进入'), { statusCode: 401 });
      beginVerified(result);
      if (refreshing?.promise === promise) refreshing.session = session;
      if (session.purchasesEnabled) await refreshPurchases();
    } catch (error) {
      if ([401, 403].includes(error.statusCode) && session?.owner.id === previous.owner.id) end();
      throw error;
    } finally {
      if (refreshing?.promise === promise) refreshing = undefined;
    }
  })();
  refreshing = { session: previous, promise };
  return promise;
}

async function refreshPurchases() {
  const activeSession = current();
  if (!activeSession.purchasesEnabled) return;
  const project = activeSession.active;
  const { items } = await ownerSession.purchases(project);
  if (session === activeSession) activeSession.records[project] = items;
}

function feedbackRequest(project, id, version, action, fields) {
  const activeSession = current();
  const key = JSON.stringify([project, id, version, action, fields]);
  let requestId = activeSession.pendingFeedback.get(key);
  if (!requestId) {
    // This is a retry identifier, not an authentication credential.
    requestId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (part) => {
      const digit = Math.floor(Math.random() * 16);
      return (part === 'x' ? digit : (digit & 3) | 8).toString(16);
    });
    activeSession.pendingFeedback.set(key, requestId);
    if (activeSession.pendingFeedback.size > 30)
      activeSession.pendingFeedback.delete(activeSession.pendingFeedback.keys().next().value);
  }
  return ownerSession
    .feedback(project, id, {
      requestId,
      version,
      action,
      ...(fields ? { feedback: fields } : {}),
    })
    .then(
      () => {
        activeSession.pendingFeedback.delete(key);
      },
      (error) => {
        if (error.statusCode >= 400 && error.statusCode < 500)
          activeSession.pendingFeedback.delete(key);
        if (error.statusCode === 401 && session?.owner.id === activeSession.owner.id) end();
        throw error;
      },
    );
}

function current() {
  if (!session) throw Error('请重新进入业主预览');
  if (session.offline) throw Error('暂时无法加载采购信息，请重试。');
  return session;
}

function snapshot() {
  const s = current();
  const all = [...s.records[s.active]]
    .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id))
    .map((item) => ({
      ...item,
      statusLabel: labels[item.state],
      overdue: reminders.level(item, s.today) === 'overdue',
    }));
  const groups = Object.fromEntries(
    Object.keys(labels).map((state) => [state, all.filter((item) => item.state === state)]),
  );
  return copy({
    owner: s.owner,
    project: s.projects.find((project) => project.id === s.active),
    projects: s.projects,
    groups,
    today: s.today,
  });
}

function ownerIdentity() {
  return session ? copy(session.owner) : null;
}

function setAvatar(path) {
  if (!session) throw Error('请重新进入业主预览');
  session.owner.avatar = path;
}

function choose(id) {
  const s = current();
  if (!s.projects.some((project) => project.id === id)) throw Error('该住宅暂不可访问');
  s.active = id;
}

function itemInProject(id, projectId, version) {
  const s = current();
  const item = s.active === projectId && s.records[s.active].find((entry) => entry.id === id);
  if (!item) throw Error('此条采购已不可见');
  if (item.state === 'complete') throw Error('公司已确认到货');
  if (item.version !== version) throw Error('采购已更新，请重新读取后再操作');
  return item;
}

function update(id, projectId, version, draft) {
  const item = itemInProject(id, projectId, version);
  const limits = { brand: 80, model: 80, note: 1000 };
  for (const [key, max] of Object.entries(limits)) {
    if (typeof draft[key] !== 'string' || draft[key].length > max)
      throw Error('购买信息过长，请缩短后重试');
  }
  const fields = Object.fromEntries(Object.keys(limits).map((key) => [key, draft[key].trim()]));
  if (!fields.brand || !fields.model) throw Error('请填写品牌和型号');
  if (isVerified()) return feedbackRequest(projectId, id, version, 'purchase', fields);
  item.feedback = fields;
  item.state = 'bought';
  item.version++;
}

function revoke(id, projectId, version) {
  const item = itemInProject(id, projectId, version);
  if (item.state !== 'bought') throw Error('该采购尚未确认购买');
  if (isVerified()) return feedbackRequest(projectId, id, version, 'withdraw');
  item.state = 'pending';
  item.version++;
}

function open(page) {
  if (!startPreview(page, !!session)) return false;
  if (session) return true;
  wx.reLaunch({ url: routes.welcome });
  return false;
}

function retry() {
  if (session) session.offline = false;
}

function end() {
  session = null;
}

module.exports = {
  begin,
  beginVerified,
  isVerified,
  refreshVerified,
  refreshPurchases,
  snapshot,
  choose,
  ownerIdentity,
  setAvatar,
  update,
  revoke,
  open,
  retry,
  end,
  blankFeedback,
  modes,
};
