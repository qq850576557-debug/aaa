const config = require('./owner-live-config');
const storageKey = 'chunmo.owner.v1.session';

function enabled() {
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
  if (!/^[a-f0-9]{64}$/.test(result.token)) throw new SessionError('登录响应异常', 0);
  wx.setStorageSync(storageKey, result.token);
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
  // Local access is cleared even if the device is offline. The server token expires.
  await request('/auth/logout', 'POST', {}, token).catch(() => {});
}

module.exports = { enabled, login, session, logout };
