const config = require('./owner-live-config');
const isolated = () => config.deployment === 'isolated';
const productionBuild = () => config.deployment === 'production' || isolated();
const unified = () => config.unified === true;
const storageKey = isolated() ? 'chunmo.owner.v21.isolated.session' : productionBuild()
  ? 'chunmo.owner.v1.production.session'
  : 'chunmo.owner.v1.session';
const entryKey = 'chunmo.mini.entry.v1';

function terms() {
  const policy = config.terms;
  return typeof policy?.version === 'string' &&
    policy.version.trim() &&
    typeof policy.text === 'string' &&
    policy.text.trim()
    ? policy
    : null;
}

function availableBuild() {
  const account = wx.getAccountInfoSync?.()?.miniProgram;
  return (
    productionBuild() &&
    (isolated() ? config.origin === 'https://owner-test.chmsj.cn' : config.origin === 'https://chmsj.cn') &&
    /^wx[a-f0-9]{16}$/i.test(config.appId ?? '') &&
    account?.appId === config.appId &&
    (isolated() ? ['develop', 'trial'] : ['develop', 'trial', 'release']).includes(account.envVersion)
  );
}

function enabled() {
  if (productionBuild())
    return Boolean(availableBuild() && terms() && typeof wx.openPrivacyContract === 'function');
  if (
    !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(config.origin) ||
    !/^wx[a-f0-9]{16}$/i.test(config.appId)
  )
    return false;
  const account = wx.getAccountInfoSync?.()?.miniProgram;
  return account?.appId === config.appId && ['develop', 'trial'].includes(account.envVersion);
}

class SessionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function request(path, method, data, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.origin + '/api/mini-owner/v1' + path,
      method,
      timeout: 15000,
      data,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      success(result) {
        const response = /** @type {{error?: string}} */ (result.data);
        if (result.statusCode === 200) return resolve(result.data);
        const revoked = result.statusCode === 401 || result.statusCode === 403;
        if (revoked && token && wx.getStorageSync(storageKey) === token)
          wx.removeStorageSync(storageKey);
        reject(
          new SessionError(response?.error || '业主服务暂时不可用，请重试', result.statusCode),
        );
      },
      fail: () => reject(new SessionError('网络异常，请稍后重试', 0)),
    });
  });
}

async function login(phoneCode, invite) {
  if (!enabled()) throw new SessionError('真实业主登录尚未开放', 403);
  const { code: loginCode } = await wx.login();
  const result = await request('/auth/login', 'POST', {
    loginCode,
    phoneCode,
    ...(invite ? { invite } : {}),
  });
  return accept(result);
}

function accept(result) {
  if (!/^[a-f0-9]{64}$/.test(result.token)) throw new SessionError('登录响应异常', 0);
  wx.setStorageSync(storageKey, result.token);
  if (productionBuild()) wx.setStorageSync(entryKey, 'owner');
  return result;
}

function session() {
  const token = enabled() && wx.getStorageSync(storageKey);
  if (!token) return Promise.resolve(null);
  return request('/session', 'GET', undefined, token);
}

async function logout() {
  const token = enabled() && wx.getStorageSync(storageKey);
  if (!token) return;
  wx.removeStorageSync(storageKey);
  if (productionBuild() && wx.getStorageSync(entryKey) === 'owner') wx.removeStorageSync(entryKey);
  // Local access is cleared even if the device is offline. The server token expires.
  await request('/auth/logout', 'POST', {}, token).catch(() => {});
}

function purchaseRequest(project, suffix, method, body) {
  const token = enabled() && wx.getStorageSync(storageKey);
  if (!token) return Promise.reject(new SessionError('业主登录已失效', 401));
  return request(
    '/projects/' + encodeURIComponent(project) + '/purchases' + suffix,
    method,
    body,
    token,
  );
}

const purchases = (project) => purchaseRequest(project, '', 'GET');
const feedback = (project, id, body) =>
  purchaseRequest(project, '/' + encodeURIComponent(id) + '/feedback', 'POST', body);
const photo = (project, id, imageId) =>
  purchaseRequest(
    project,
    '/' + encodeURIComponent(id) + '/photo/' + encodeURIComponent(imageId),
    'GET',
  );

module.exports = {
  productionBuild,
  unified,
  accept,
  availableBuild,
  terms,
  enabled,
  login,
  session,
  logout,
  purchases,
  feedback,
  photo,
};
