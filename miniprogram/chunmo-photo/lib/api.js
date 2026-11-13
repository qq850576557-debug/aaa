const { origin } = require('../config');
const { call } = require('./platform');
const routes = {
  login: 'POST',
  session: 'GET',
  logout: 'POST',
  identity: 'GET',
  nearby: 'POST',
  renew: 'POST',
};
class Api {
  constructor() {
    this.cookie = '';
    this.csrf = '';
    this.proof = '';
    this.expiresAt = 0;
    this.identity = null;
  }
  clear() {
    this.cookie = '';
    this.csrf = '';
    this.identity = null;
  }
  async raw(path, data, method, proof = '') {
    const response = await call('request', {
      url: origin + '/api/mini-photo/' + path,
      method,
      timeout: 20000,
      data,
      enableHttp2: true,
      header: {
        'content-type': 'application/json',
        'X-Chunmo-Mini-Proof': proof,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        'X-CSRF-Token': this.csrf,
      },
    });
    // Use the runtime cookies array when available; never persist the password or
    // session cookie in wx storage. Only our exact cookie is forwarded.
    const headers = response.header || {};
    const cookies =
      response.cookies ||
      Object.keys(headers)
        .filter((k) => k.toLowerCase() === 'set-cookie')
        .map((k) => headers[k]);
    for (const value of cookies) {
      const match = String(value).match(/(?:^|,\s*)(chunmo_session=([a-f0-9]{64}))(?:;|$)/);
      if (match) this.cookie = match[1];
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = Object.assign(
        Error((response.data && response.data.error) || '请求失败 HTTP ' + response.statusCode),
        { code: response.data && response.data.code, status: response.statusCode },
      );
      if (error.status === 401 && path !== 'bootstrap' && error.code !== 'MINI_PROOF_EXPIRED')
        this.clear();
      throw error;
    }
    return response.data;
  }
  async bootstrap() {
    if (this.proof && this.expiresAt > Date.now() + 30000) return;
    if (!this.booting)
      this.booting = (async () => {
        const { code } = await call('login', { timeout: 10000 });
        const result = await this.raw('bootstrap', { code }, 'POST');
        this.proof = result.proof;
        this.expiresAt = result.expiresAt;
      })().finally(() => {
        this.booting = null;
      });
    await this.booting;
  }
  async request(path, data) {
    if (!routes[path]) throw Error('小程序不支持此接口');
    await this.bootstrap();
    try {
      return await this.raw(path, data, routes[path], this.proof);
    } catch (error) {
      // This rejection is before the original handler: retry cannot duplicate a mutation.
      if (error.code !== 'MINI_PROOF_EXPIRED') throw error;
      this.expiresAt = 0;
      await this.bootstrap();
      return this.raw(path, data, routes[path], this.proof);
    }
  }
  async login(login, password) {
    await this.request('login', { login, password });
    const session = await this.request('session');
    this.csrf = session.csrf;
    const config = await this.request('identity');
    if (!session.user || config.actorId !== session.user.id || !config.actorName) {
      this.clear();
      throw Error('登录身份校验失败');
    }
    this.identity = Object.freeze({
      id: session.user.id,
      workspaceId: session.user.workspaceId,
      name: config.actorName,
    });
    return this.identity;
  }
  async logout() {
    try {
      await this.request('logout', {});
    } finally {
      this.clear();
    }
  }
}
module.exports = { Api };
