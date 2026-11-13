const { origin, apiPrefix = '/api/mini-photo/' } = require('../config');
const { call } = require('./platform');
const routes = {
  login: 'POST',
  session: 'GET',
  logout: 'POST',
  identity: 'GET',
  nearby: 'POST',
  renew: 'POST',
  'workbench/workspace': 'GET',
  'workbench/records': 'GET',
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
      url: origin + apiPrefix + path,
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
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data))
      throw Object.assign(Error('云端未返回有效JSON确认，提交仍待核对'), {
        status: 0,
        code: 'INVALID_API_RESPONSE',
      });
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
  async request(path, data, requestedMethod) {
    const dynamic = /^workbench\/records\/[a-f0-9-]{36}(\/history)?$/.test(path);
    const method = requestedMethod || routes[path] || (dynamic ? 'GET' : '');
    const allowed =
      (path === 'workbench/workspace' && ['GET', 'PUT'].includes(method)) ||
      (path === 'workbench/records' && ['GET', 'POST'].includes(method)) ||
      (dynamic && (path.endsWith('/history') ? method === 'GET' : method === 'PUT')) ||
      (!path.startsWith('workbench/') && routes[path] === method);
    if (!allowed) throw Error('小程序不支持此接口');
    const owner = path.startsWith('workbench/') ? this.identity : null;
    const checkOwner = () => {
      if (
        path.startsWith('workbench/') &&
        (!owner ||
          !this.identity ||
          owner.id !== this.identity.id ||
          owner.workspaceId !== this.identity.workspaceId)
      )
        throw Object.assign(Error('账号已变化，未发送旧账号工作提交'), {
          status: 0,
          code: 'OWNER_CHANGED',
        });
    };
    await this.bootstrap();
    checkOwner();
    try {
      return await this.raw(path, data, method, this.proof);
    } catch (error) {
      // This rejection is before the original handler: retry cannot duplicate a mutation.
      if (error.code !== 'MINI_PROOF_EXPIRED') throw error;
      this.expiresAt = 0;
      await this.bootstrap();
      checkOwner();
      return this.raw(path, data, method, this.proof);
    }
  }
  async login(login, password) {
    await this.request('login', { login, password });
    return this.restore();
  }
  async restore() {
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
