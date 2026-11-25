const assert = require('node:assert/strict');
const test = require('node:test');
const { origin } = require('../config');
const { withEmployeeRemember, resumeEntry } = require('../lib/employee-remember');

test('employee cold start restores once, reuses local photo identity, and forgets on logout', async () => {
  const key = 'chunmo.employee.v1.remembered:' + origin;
  const entryKey = 'chunmo.mini.entry.v1';
  const ownerKey = 'chunmo.owner.v1.production.session';
  const token = 'a'.repeat(64);
  const cookie = 'chunmo_session=' + 'b'.repeat(64);
  const actor = { id: 'emp', workspaceId: 'ws', name: '测试' };
  const local = new Map();
  const requests = [];
  const navigation = [];
  let outcome = 'available';
  const AppApi = withEmployeeRemember(
    class {
      async login() {
        this.cookie = cookie;
        this.csrf = 'synthetic_csrf';
        return (this.identity = actor);
      }
      async request(path) {
        if (path === 'session') return { user: actor, csrf: 'synthetic_csrf' };
        if (path === 'identity') return { actorId: actor.id, actorName: actor.name };
        if (path === 'workbench/workspace') return { actor: this.identity };
      }
      clear() {
        this.cookie = '';
        this.identity = null;
      }
      async logout() {
        this.clear();
      }
    },
  );
  global.wx = {
    login: ({ success }) => success({ code: 'synthetic_code' }),
    getStorageSync: (name) => local.get(name),
    setStorageSync: (name, value) => local.set(name, value),
    removeStorageSync: (name) => local.delete(name),
    request: ({ url, header, data, success, fail }) => {
      const route = url.split('/').at(-1);
      requests.push(route);
      assert.equal(data.code, 'synthetic_code');
      if (route === 'remember') {
        assert.equal(header.Cookie, cookie);
        success({
          statusCode: 200,
          data: { token, expiresAt: new Date(Date.now() + 86400000).toISOString() },
        });
      } else {
        assert.equal(header.Cookie, undefined);
        assert.equal(data.token, token);
        if (route === 'resume' && outcome === 'offline') fail(Error('offline'));
        else if (route === 'resume' && outcome === 'expired')
          success({ statusCode: 401, data: { code: 'MINI_EMPLOYEE_EXPIRED' } });
        else
          success({
            statusCode: 200,
            data: { ok: true },
            header: { 'Set-Cookie': cookie + '; Path=/api' },
          });
      }
    },
    redirectTo: ({ url, success }) => {
      navigation.push(url);
      success();
    },
    switchTab: ({ url, success }) => {
      navigation.push(url);
      success();
    },
  };
  const first = new AppApi();
  await first.login('test', 'password');
  assert.equal(local.get(key).token, token);
  assert.equal(local.get(entryKey), 'employee');
  assert(!JSON.stringify([...local]).includes(cookie));
  const cold = new AppApi();
  const app = { api: cold, engine: { store: { identity: actor } } };
  global.getApp = () => app;
  const page = {
    data: {},
    setData(change) {
      Object.assign(this.data, change);
    },
  };
  await resumeEntry(page, { manual: '1' }, true);
  assert.equal(navigation.length, 0);
  await Promise.all([resumeEntry(page, {}, true), cold.resumeRemembered()]);
  assert.deepEqual(navigation, ['/pages/workbench/index']);
  assert.equal(requests.filter((route) => route === 'resume').length, 1);
  assert.deepEqual((await cold.request('workbench/workspace')).actor, actor);
  cold.cookieValidUntil = 0;
  assert.deepEqual((await cold.request('workbench/workspace')).actor, actor);
  assert.equal(requests.filter((route) => route === 'resume').length, 2);
  await cold.logout();
  assert(!local.has(key) && !local.has(entryKey));
  assert.equal(requests.at(-1), 'forget');
  await first.login('test', 'password');
  outcome = 'offline';
  await assert.rejects(new AppApi().resumeRemembered(), /offline/);
  assert(local.has(key));
  outcome = 'expired';
  assert.equal(await new AppApi().resumeRemembered(), null);
  assert(!local.has(key));
  local.set(entryKey, 'owner');
  local.set(ownerKey, 'c'.repeat(64));
  await resumeEntry(page, {}, true);
  assert.equal(navigation.at(-1), '/owner-login/pages/welcome/index');
});
