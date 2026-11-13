const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('../lib/api');
test('wx code proof, exact employee cookie, CSRF and server identity; no Origin spoof', async (t) => {
  const seen = [],
    cookie = 'a'.repeat(64);
  const previous = global.wx;
  t.after(() => {
    global.wx = previous;
  });
  global.wx = {
    login: (o) => o.success({ code: 'synthetic-code' }),
    request(o) {
      seen.push(o);
      const route = o.url.split('/').pop();
      const result = {
        bootstrap: { proof: 'synthetic-proof', expiresAt: Date.now() + 600000 },
        login: { ok: true },
        session: { csrf: 'test-csrf', user: { id: 'actor', workspaceId: 'workspace' } },
        identity: { actorId: 'actor', actorName: '服务端姓名' },
        nearby: { places: [], more: false },
      }[route];
      o.success({
        statusCode: 200,
        data: result,
        cookies:
          route === 'login'
            ? ['other=ignore', 'chunmo_session=' + cookie + '; HttpOnly; Secure']
            : [],
        header: {},
      });
    },
  };
  const api = new Api();
  const identity = await api.login('test-login', 'secret-test');
  await api.request('nearby', { fixture: true });
  assert.equal(identity.name, '服务端姓名');
  assert.equal(api.cookie, 'chunmo_session=' + cookie);
  assert.equal(seen.at(-1).header['X-CSRF-Token'], 'test-csrf');
  assert.equal(seen.at(-1).header.Origin, undefined);
  assert.equal(seen.at(-1).header['X-Chunmo-Mini-Proof'], 'synthetic-proof');
  assert.equal(seen.filter((o) => o.url.endsWith('bootstrap')).length, 1);
  await assert.rejects(api.request('workspace', {}));
  assert.ok(!Object.keys(api).includes('password'));
  assert.equal(Object.isFrozen(identity), true);
});
test('identity mismatch and failed login never create a usable photo identity', async (t) => {
  const previous = global.wx;
  t.after(() => {
    global.wx = previous;
  });
  let failLogin = false;
  global.wx = {
    login: (o) => o.success({ code: 'test' }),
    request(o) {
      const route = o.url.split('/').pop();
      const data = {
        bootstrap: { proof: 'test', expiresAt: Date.now() + 600000 },
        login: { error: '账号或密码不正确' },
        session: { csrf: 'csrf', user: { id: 'one', workspaceId: 'w' } },
        identity: { actorId: 'another', actorName: '伪身份' },
      }[route];
      o.success({
        statusCode: failLogin && route === 'login' ? 401 : 200,
        data,
        cookies: [],
        header: {},
      });
    },
  };
  const api = new Api();
  await assert.rejects(api.login('a', 'b'), /身份校验/);
  assert.equal(api.identity, null);
  failLogin = true;
  await assert.rejects(api.login('a', 'b'), /账号或密码/);
  assert.equal(api.cookie, '');
});
test('only explicit proof-expired rejection is retried, network mutations are never blindly retried', async (t) => {
  const previous = global.wx;
  t.after(() => {
    global.wx = previous;
  });
  let boot = 0,
    calls = 0,
    networkFailure = false;
  global.wx = {
    login: (o) => o.success({ code: 'test' }),
    request(o) {
      if (o.url.endsWith('bootstrap'))
        return o.success({
          statusCode: 200,
          data: { proof: 'test-' + ++boot, expiresAt: Date.now() + 600000 },
          cookies: [],
        });
      calls++;
      if (networkFailure) return o.fail(Error('network interrupted'));
      o.success({
        statusCode: calls === 1 ? 401 : 200,
        data: calls === 1 ? { code: 'MINI_PROOF_EXPIRED' } : { ok: true },
        cookies: [],
      });
    },
  };
  const api = new Api();
  assert.equal((await api.request('renew', {})).ok, true);
  assert.equal(boot, 2);
  assert.equal(calls, 2);
  networkFailure = true;
  await assert.rejects(api.request('renew', {}));
  assert.equal(calls, 3);
});
