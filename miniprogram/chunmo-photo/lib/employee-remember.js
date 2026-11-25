const { origin } = require('../config');
const { call, message } = require('./platform');
const { enter } = require('./session');

const rememberedKey = 'chunmo.employee.v1.remembered:' + origin;
const entryKey = 'chunmo.mini.entry.v1';
const ownerKey = 'chunmo.owner.v1.production.session';
const cookieDuration = (8 * 60 - 1) * 60 * 1000;

function read(key) {
  try {
    return wx.getStorageSync(key);
  } catch {
    return undefined;
  }
}

function write(key, value) {
  try {
    if (value === undefined) wx.removeStorageSync(key);
    else wx.setStorageSync(key, value);
  } catch {
    // Local storage errors must not prevent the existing password login.
  }
}

function rememberedToken() {
  const value = read(rememberedKey);
  if (!value) return '';
  if (!/^[a-f0-9]{64}$/.test(value.token) || !(Date.parse(value.expiresAt) > Date.now())) {
    write(rememberedKey, undefined);
    return '';
  }
  return value.token;
}

async function exchange(api, route, token) {
  const { code } = await call('login', { timeout: 10000 });
  const reply = await call('request', {
    url: origin + '/api/mini-employee/v1/' + route,
    method: 'POST',
    timeout: 15000,
    data: token ? { code, token } : { code },
    header: {
      'content-type': 'application/json',
      ...(route === 'remember' ? { Cookie: api.cookie, 'X-CSRF-Token': api.csrf } : {}),
    },
  });
  if (reply.statusCode !== 200)
    throw Object.assign(Error(reply.data?.error || '暂时无法恢复员工登录'), {
      code: reply.data?.code,
    });
  return reply;
}

function sessionCookie(response) {
  const headers = response.header || {};
  const cookies = response.cookies?.length
    ? response.cookies
    : Object.keys(headers)
        .filter((key) => key.toLowerCase() === 'set-cookie')
        .map((key) => headers[key]);
  return cookies
    .map((value) => String(value).match(/(?:^|,\s*)(chunmo_session=[a-f0-9]{64})(?:;|$)/))
    .find(Boolean)?.[1];
}

function withEmployeeRemember(BaseApi) {
  return class extends BaseApi {
    async login(login, password) {
      this.changingSession = true;
      try {
        const identity = await super.login(login, password);
        this.cookieValidUntil = Date.now() + cookieDuration;
        write(entryKey, 'employee');
        const prior = rememberedToken();
        write(rememberedKey, undefined);
        const remember = async () => {
          if (prior) await exchange(this, 'forget', prior).catch(() => {});
          const { data } = await exchange(this, 'remember');
          if (/^[a-f0-9]{64}$/.test(data?.token) && Date.parse(data.expiresAt) > Date.now())
            write(rememberedKey, { token: data.token, expiresAt: data.expiresAt });
        };
        await remember().catch(() => {});
        return identity;
      } finally {
        this.changingSession = false;
      }
    }

    async personalProfile() {
      // Refresh expired eight-hour staff cookies through the existing remembered session.
      if (!this.cookie || this.cookieValidUntil <= Date.now()) await this.resumeRemembered();
      const identity = this.identity;
      if (!identity || !this.cookie) return null;
      const response = await call('request', {
        url: origin + '/api/mini-employee/v1/profile',
        method: 'GET',
        timeout: 15000,
        header: { Cookie: this.cookie },
      });
      if (this.identity !== identity || response.statusCode !== 200) return null;
      return response.data;
    }

    async acceptWechat(response) {
      const { token, expiresAt } = response.data.remembered || {};
      const cookie = sessionCookie(response);
      if (!cookie || !/^[a-f0-9]{64}$/.test(token) || !(Date.parse(expiresAt) > Date.now()))
        throw Error('员工登录响应异常，请重试');
      this.changingSession = true;
      try {
        this.clear();
        this.cookie = cookie;
        const identity = await super.restore();
        const prior = rememberedToken();
        write(rememberedKey, { token, expiresAt });
        if (prior && prior !== token) await exchange(this, 'forget', prior).catch(() => {});
        write(entryKey, 'employee');
        this.cookieValidUntil = Date.now() + cookieDuration;
        return identity;
      } finally {
        this.changingSession = false;
      }
    }

    async resumeRemembered() {
      if (!this.resuming) {
        const remember = rememberedToken();
        if (!remember) return null;
        this.resuming = this.loadRemembered(remember).finally(() => {
          this.resuming = null;
        });
      }
      return this.resuming;
    }

    async loadRemembered(token) {
      const prior = this.identity;
      try {
        const response = await exchange(this, 'resume', token);
        const cookie = sessionCookie(response);
        if (!cookie || rememberedToken() !== token) return null;
        this.cookie = cookie;
        const session = await super.request('session');
        this.csrf = session.csrf;
        const actor = await super.request('identity');
        if (rememberedToken() !== token) return null;
        const user = session.user;
        if (
          !user ||
          actor.actorId !== user.id ||
          !actor.actorName ||
          (prior && (prior.id !== user.id || prior.workspaceId !== user.workspaceId))
        ) {
          this.clear();
          write(rememberedKey, undefined);
          throw Error('登录身份校验失败，请重新登录');
        }
        this.cookieValidUntil = Date.now() + cookieDuration;
        this.identity = Object.freeze({
          id: user.id,
          workspaceId: user.workspaceId,
          name: actor.actorName,
        });
        write(entryKey, 'employee');
        return this.identity;
      } catch (error) {
        if (error.code === 'MINI_EMPLOYEE_EXPIRED') {
          if (rememberedToken() === token) write(rememberedKey, undefined);
          this.clear();
          return null;
        }
        throw error;
      }
    }

    async request(path, data, method) {
      if (
        !this.changingSession &&
        path !== 'logout' &&
        path !== 'login' &&
        (!this.cookie || this.cookieValidUntil <= Date.now()) &&
        rememberedToken()
      ) {
        if (!(await this.resumeRemembered())) throw Error('员工登录已失效，请重新登录');
      }
      return super.request(path, data, method);
    }

    async logout() {
      const token = rememberedToken();
      write(rememberedKey, undefined);
      if (read(entryKey) === 'employee') write(entryKey, undefined);
      if (token) await exchange(this, 'forget', token).catch(() => {});
      return super.logout();
    }
  };
}

async function resumeEntry(page, options, workbench) {
  if (options?.manual === '1') return;
  const owner = read(entryKey) === 'owner' && /^[a-f0-9]{64}$/.test(read(ownerKey) || '');
  const app = getApp();
  if (!owner && !rememberedToken() && !(app.api?.identity && app.engine)) return;
  if (page.data.busy) return;
  page.setData({ busy: true, error: '' });
  try {
    if (owner) {
      await call('redirectTo', { url: '/owner-login/pages/welcome/index' });
      return;
    }
    const identity = rememberedToken()
      ? await app.api.resumeRemembered()
      : (await app.api.restore?.()) || app.api.identity;
    if (!identity) return;
    const engineIdentity = app.engine?.store.identity;
    if (engineIdentity?.id !== identity.id || engineIdentity?.workspaceId !== identity.workspaceId)
      await enter(identity);
    await call(workbench ? 'switchTab' : 'redirectTo', {
      url: workbench ? '/pages/workbench/index' : '/pages/places/index',
    });
  } catch (error) {
    page.setData({ error: message(error) });
  } finally {
    page.setData({ busy: false });
  }
}

module.exports = { withEmployeeRemember, resumeEntry };
