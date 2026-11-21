import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createApp } from './app';
import { pool, privatePool } from './db';
import { hash } from './store';
import { migrate } from './migrate';
import { officialOwnerWechat } from './owner-wechat';

test('official adapter binds the verified phone to the configured app and never accepts a client phone', async () => {
  const appId = 'wx1111111111111111';
  const seen: string[] = [];
  let wrongApp = false;
  const verifier = officialOwnerWechat(appId, 'isolated-example', async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.weixin.qq.com');
    assert.equal(init?.redirect, 'error');
    seen.push(url.pathname);
    if (url.pathname === '/sns/jscode2session') {
      assert.equal(url.searchParams.get('js_code'), 'login-code');
      return Response.json({ openid: 'isolated_wx' });
    }
    if (url.pathname === '/cgi-bin/stable_token')
      return Response.json({ access_token: 'provider-token', expires_in: 7200 });
    assert.equal(url.pathname, '/wxa/business/getuserphonenumber');
    assert.deepEqual(JSON.parse(String(init?.body)), { code: 'phone-code' });
    return Response.json({
      errcode: 0,
      phone_info: {
        countryCode: '86',
        purePhoneNumber: '13900000001',
        watermark: { appid: wrongApp ? 'wrong' : appId },
      },
    });
  });
  assert.deepEqual(await verifier.verify('login-code', 'phone-code'), {
    openid: 'isolated_wx',
    phone: '13900000001',
  });
  wrongApp = true;
  await assert.rejects(() => verifier.verify('login-code', 'phone-code'), /无法验证/);
  assert.equal(seen.filter((item) => item === '/cgi-bin/stable_token').length, 1);
});

test('real PostgreSQL roles, employee CSRF, invitation, two households, revocation, rebind and project deletion', async (t) => {
  const url = process.env.MIGRATION_DATABASE_URL;
  const ownerUrl = process.env.CHUNMO_OWNER_DATABASE_URL;
  assert.ok(process.env.APP_ENV === 'test' && url && ownerUrl);
  for (const config of [
    url,
    ownerUrl,
    process.env.DATABASE_URL!,
    process.env.PRIVATE_DATABASE_URL!,
  ]) {
    const address = new URL(config);
    assert.equal(address.hostname, '127.0.0.1');
    assert.equal(address.pathname, '/chunmo_owner_auth_test');
  }
  await migrate(url);
  const admin = new pg.Pool({ connectionString: url });
  const runtime = new pg.Pool({ connectionString: ownerUrl });
  t.after(async () => {
    await Promise.all([admin.end(), runtime.end(), pool.end(), privatePool.end()]);
  });
  const staff = new URL(process.env.DATABASE_URL!);
  const ownerDb = new URL(ownerUrl);
  function roleFor(user: URL) {
    assert.match(user.username, /^[a-z_]+$/);
    assert.match(user.password, /^[a-f0-9]{48}$/);
    return 'CREATE ROLE ' + user.username + " LOGIN NOINHERIT PASSWORD '" + user.password + "'";
  }
  await admin.query(roleFor(staff));
  await admin.query(roleFor(ownerDb));
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM schema_migration')).rows[0].n,
    15,
  );
  await admin.query(await readFile('server/proposed/016_owner_identity.sql', 'utf8'));
  await admin.query(
    (await readFile('server/proposed/016_owner_identity_grants.sql', 'utf8'))
      .replaceAll(':"staff_role"', staff.username)
      .replaceAll(':"owner_role"', ownerDb.username),
  );
  await admin.query(
    'GRANT SELECT ON account,auth_session,cloud_workspace,account_avatar,card_avatar TO ' +
      staff.username,
  );
  await admin.query('GRANT SELECT,UPDATE,DELETE ON project TO ' + staff.username);
  await admin.query('GRANT INSERT ON audit_event TO ' + staff.username);

  await admin.query(`BEGIN;
    INSERT INTO cloud_workspace VALUES ('w','模拟工作室','founder'),('other','外部','external');
    INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES
      ('founder','w','founder','test','owner'),('employee','w','employee','test','employee'),('external','other','external','test','owner');
    INSERT INTO project VALUES
      ('w','p1','{"name":"一号住宅","status":"施工中","notes":"PRIVATE-NOTE"}'),
      ('w','p2','{"name":"二号住宅","status":"筹备中","address":"PRIVATE-ADDRESS"}'),
      ('other','secret','{"name":"外部住宅"}');
    COMMIT;`);
  const founder = '1'.repeat(64),
    employee = '2'.repeat(64);
  await admin.query(
    "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,'founder',now()+interval '1 day'),($2,'employee',now()+interval '1 day')",
    [hash(founder), hash(employee)],
  );

  let verified = { openid: 'demo_a', phone: '13900000001' };
  let providerCalls = 0;
  const app = createApp({
    ownerPortal: {
      key: process.env.CHUNMO_OWNER_DATA_KEY!,
      db: runtime,
      wechat: {
        appId: 'wx1111111111111111',
        async verify() {
          providerCalls++;
          return verified;
        },
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  const binding = server.address() as import('node:net').AddressInfo;
  const base = 'http://127.0.0.1:' + binding.port;
  async function request(
    path: string,
    method = 'GET',
    body?: object,
    staffToken = '',
    bearer = '',
    csrf = true,
  ) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
        ...(staffToken
          ? {
              Cookie: 'chunmo_session=' + staffToken,
              ...(csrf ? { 'X-CSRF-Token': hash('csrf:' + staffToken) } : {}),
            }
          : {}),
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const staffApi = (p = 'p1') => '/projects/' + p + '/owner-access';
  const auth = '/mini-owner/v1/auth/login';
  const projects = '/mini-owner/v1/projects';
  const login = (invite?: string) =>
    request(auth, 'POST', {
      loginCode: 'mock_login',
      phoneCode: 'mock_phone',
      ...(invite ? { invite } : {}),
    });
  assert.equal((await request(staffApi(), 'GET', undefined, employee)).status, 403);
  assert.equal(
    (await request(staffApi() + '/members', 'POST', { name: '甲', phone: '13900000001' }, employee))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        staffApi() + '/members',
        'POST',
        { name: '甲', phone: '13900000001' },
        founder,
        '',
        false,
      )
    ).status,
    403,
  );
  assert.equal((await request(staffApi('secret'), 'GET', undefined, founder)).status, 404);
  for (const p of ['p1', 'p2'])
    assert.equal(
      (await request(staffApi(p) + '/service', 'PUT', { enabled: true }, founder)).status,
      200,
    );
  const inviteA = (
    await request(staffApi() + '/members', 'POST', { name: '甲', phone: '13900000001' }, founder)
  ).body.invite;
  const inviteB = (
    await request(staffApi() + '/members', 'POST', { name: '乙', phone: '13900000002' }, founder)
  ).body.invite;
  await request(staffApi('p2') + '/members', 'POST', { name: '甲', phone: '13900000001' }, founder);
  assert.ok(inviteA && inviteB);
  assert.equal(
    (await request(auth, 'POST', { loginCode: 'fake', phoneCode: 'fake', phone: '13900000001' }))
      .status,
    400,
  );
  assert.equal((await login('f'.repeat(64))).status, 403);
  assert.equal(providerCalls, 0);
  const result = await login(inviteA);
  assert.equal(result.status, 200);
  const tokenA = result.body.token as string;
  assert.deepEqual(result.body.projects.map((item: { id: string }) => item.id).sort(), [
    'p1',
    'p2',
  ]);
  for (const item of result.body.projects)
    assert.deepEqual(Object.keys(item).sort(), ['id', 'phase', 'title']);
  assert.equal((await login(inviteA)).status, 403);
  verified = { openid: 'demo_conflict', phone: '13900000001' };
  const replacement = (
    await request(staffApi() + '/members', 'POST', { name: '甲', phone: '13900000001' }, founder)
  ).body.invite;
  assert.equal((await login(replacement)).status, 403);
  verified = { openid: 'demo_b', phone: '13900000002' };
  const resultB = await login(inviteB);
  assert.equal(resultB.status, 200);
  const tokenB = resultB.body.token as string;
  assert.equal((await request('/auth/session', 'GET', undefined, '', tokenA)).status, 401);
  assert.equal((await request(projects, 'GET', undefined, founder)).status, 401);
  assert.equal((await request('/mini-owner/v1/records', 'GET', undefined, '', tokenA)).status, 404);
  assert.equal((await request('/auth/session', 'GET', undefined, employee)).status, 200);
  for (const table of [
    'project',
    'purchase',
    'work_record',
    'account',
    'workspace_state',
    'owner_portal.project_grant',
  ])
    await assert.rejects(
      () => runtime.query('SELECT * FROM ' + table),
      (e: any) => e.code === '42501',
    );
  await assert.rejects(
    () => runtime.query('SELECT phone_sealed FROM owner_portal.member'),
    (e: any) => e.code === '42501',
  );
  const list = (await request(staffApi(), 'GET', undefined, founder)).body.members;
  assert.equal(list.find((row: { name: string }) => row.name === '甲').maskedPhone, '*******0001');
  assert.ok(!JSON.stringify(list).includes('13900000001'));
  const id = list.find((row: { name: string }) => row.name === '甲').id;
  assert.equal(
    (await request(staffApi() + '/members/' + id, 'DELETE', {}, founder)).status,
    200,
  );
  assert.deepEqual(
    (await request(projects, 'GET', undefined, '', tokenA)).body.projects.map(
      (row: { id: string }) => row.id,
    ),
    ['p2'],
  );
  assert.equal((await request(projects, 'GET', undefined, '', tokenB)).status, 200);
  const rebind = (await request(staffApi('p2') + '/members/' + id + '/rebind', 'POST', {}, founder))
    .body.invite;
  assert.equal((await request(projects, 'GET', undefined, '', tokenA)).status, 401);
  verified = { openid: 'demo_new_a', phone: '13900000001' };
  const newSession = await login(rebind);
  assert.equal(newSession.status, 200);
  await pool.query("DELETE FROM project WHERE workspace_id='w' AND id='p2'");
  await admin.query("INSERT INTO project VALUES('w','p2','{}')");
  assert.equal((await request(projects, 'GET', undefined, '', newSession.body.token)).status, 403);
  assert.equal((await request(projects, 'GET', undefined, '', tokenB)).status, 200);
  assert.equal((await request('/mini-owner/v1/auth/logout', 'POST', {}, '', tokenB)).status, 200);
  assert.equal((await request(projects, 'GET', undefined, '', tokenB)).status, 401);
});
