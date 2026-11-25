const { origin } = require('../config');
const { call } = require('./platform');
const { enter } = require('./session');

const entry = '/owner-login/pages/welcome/index';
const lastRole = 'chunmo.mini.entry.v1';
const dualKey = 'chunmo.mini.v21.dual';

async function exchange(route, values = {}) {
  const { code } = await call('login', { timeout: 10000 });
  const response = await call('request', {
    url: origin + '/api/mini-login/v1/' + route,
    method: 'POST',
    timeout: 15000,
    header: { 'content-type': 'application/json' },
    data: { ...values, code },
  });
  if (response.statusCode !== 200 || !response.data)
    throw Error(response.data?.error || '暂时无法微信登录，请稍后重试');
  return response;
}

async function staffHome(identity) {
  const app = getApp();
  const current = app.engine?.store.identity;
  if (current?.id !== identity.id || current.workspaceId !== identity.workspaceId)
    await enter(identity);
  if (app.engine) app.engine.active = true;
  wx.setStorageSync(lastRole, 'employee');
  await call('switchTab', { url: '/pages/workbench/index' });
}

module.exports = {
  entry,
  lastRole,
  exchange,
  staffHome,
  canSwitch: () => wx.getStorageSync(dualKey) === true,
  setDual: (roles) =>
    wx.setStorageSync(dualKey, roles.includes('employee') && roles.includes('owner')),
};
