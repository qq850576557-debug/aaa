import { migrateEmployeeWechatTest } from '../deploy/owner-release/migrate-019-test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import test from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from './app';
import { config } from './config';
import { pool, privatePool } from './db';
import { ApiError, hash } from './store';
import { migrate } from './migrate';
import { officialOwnerWechat } from './owner-wechat';
import { passwordHash } from './auth';
import { emptyData, newProject } from '../src/lib/model';
import { emptyHistory } from '../src/lib/history';

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
    'GRANT SELECT ON account,auth_session,cloud_workspace,account_avatar,card_avatar,account_note TO ' +
      staff.username,
  );
  await admin.query('GRANT UPDATE ON account TO ' + staff.username);
  await admin.query('GRANT INSERT,DELETE ON auth_session TO ' + staff.username);
  await admin.query('GRANT SELECT,INSERT,UPDATE ON login_limit TO ' + staff.username);
  const migration = await readFile('server/proposed/017_owner_purchase.sql', 'utf8');
  const grants = await readFile('server/proposed/017_owner_purchase_grants.sql', 'utf8');
  const evidence = await readFile('server/proposed/018_owner_purchase_evidence.sql', 'utf8');
  const evidenceGrants = await readFile(
    'server/proposed/018_owner_purchase_evidence_grants.sql',
    'utf8',
  );
  await admin.query('CREATE ROLE owner_photo_backup NOLOGIN NOINHERIT');
  const migrationClient = await admin.connect();
  try {
    await migrationClient.query('BEGIN');
    await migrationClient.query(migration);
    await migrationClient.query(
      grants
        .replaceAll(':"staff_role"', staff.username)
        .replaceAll(':"owner_role"', ownerDb.username),
    );
    await migrationClient.query(
      "INSERT INTO owner_portal.purchase_migration(filename,sha256) VALUES('017_owner_purchase.sql',$1),('017_owner_purchase_grants.sql',$2)",
      [hash(migration), hash(grants)],
    );
    await migrationClient.query(`
      INSERT INTO owner_portal.purchase_collaboration
        (workspace_id,project_id,purchase_id,responsibility,title,description,specification,quantity,reference,bought,brand,model,note)
      VALUES ('legacy-w','legacy-home','legacy-item','owner','旧采购','','','','',true,'旧品牌','旧型号','旧备注')
    `);
    await migrationClient.query('COMMIT');
    await migrationClient.query('BEGIN');
    await migrationClient.query(evidence);
    await migrationClient.query(
      evidenceGrants
        .replaceAll(':"staff_role"', staff.username)
        .replaceAll(':"owner_role"', ownerDb.username)
        .replaceAll(':"backup_role"', 'owner_photo_backup'),
    );
    await migrationClient.query(
      "INSERT INTO owner_portal.purchase_migration(filename,sha256) VALUES('018_owner_purchase_evidence.sql',$1),('018_owner_purchase_evidence_grants.sql',$2)",
      [hash(evidence), hash(evidenceGrants)],
    );
    const legacy = await migrationClient.query(
      "SELECT bought,brand,model,note,feedback_link,feedback_photo FROM owner_portal.purchase_collaboration WHERE purchase_id='legacy-item'",
    );
    assert.deepEqual(legacy.rows, [
      {
        bought: true,
        brand: '旧品牌',
        model: '旧型号',
        note: '旧备注',
        feedback_link: '',
        feedback_photo: null,
      },
    ]);
    await migrationClient.query('COMMIT');
  } catch (error) {
    await migrationClient.query('ROLLBACK');
    throw error;
  } finally {
    migrationClient.release();
  }
  await migrateEmployeeWechatTest(url, staff.username);
  await migrateEmployeeWechatTest(url, staff.username);
  const staffBindingLedger = await admin.query(
    "SELECT name,checksum FROM schema_migration WHERE name LIKE '019_%'",
  );
  assert.equal(staffBindingLedger.rowCount, 2);
  for (const row of staffBindingLedger.rows)
    assert.equal(row.checksum, hash(await readFile('server/proposed/' + row.name, 'utf8')));
  await admin.query("UPDATE schema_migration SET checksum='tampered' WHERE name=$1", [
    staffBindingLedger.rows[0].name,
  ]);
  await assert.rejects(() => migrateEmployeeWechatTest(url, staff.username), /checksum mismatch/);
  await admin.query('UPDATE schema_migration SET checksum=$2 WHERE name=$1', [
    staffBindingLedger.rows[0].name,
    staffBindingLedger.rows[0].checksum,
  ]);
  assert.equal(
    (
      await admin.query(
        "SELECT has_table_privilege($1,'public.employee_wechat_binding','SELECT') AS staff,has_table_privilege($2,'public.employee_wechat_binding','SELECT') AS owner",
        [staff.username, ownerDb.username],
      )
    ).rows[0].staff,
    true,
  );
  assert.equal(
    (
      await admin.query('SELECT has_table_privilege($1,$2,$3) AS ok', [
        ownerDb.username,
        'public.employee_wechat_binding',
        'SELECT',
      ])
    ).rows[0].ok,
    false,
  );
  const designFiles = ['020_owner_design.sql', '020_owner_design_grants.sql'];
  const [design, designGrants] = await Promise.all(
    designFiles.map((file) => readFile('server/proposed/' + file, 'utf8')),
  );
  const designMigration = await admin.connect();
  try {
    await designMigration.query('BEGIN');
    await designMigration.query(design);
    await designMigration.query(
      designGrants
        .replaceAll(':"staff_role"', staff.username)
        .replaceAll(':"owner_role"', ownerDb.username),
    );
    for (const [i, file] of designFiles.entries())
      await designMigration.query('INSERT INTO schema_migration(name,checksum) VALUES($1,$2)', [
        file,
        hash([design, designGrants][i]),
      ]);
    await designMigration.query('COMMIT');
  } catch (e) {
    await designMigration.query('ROLLBACK');
    throw e;
  } finally {
    designMigration.release();
  }
  const retirement = await readFile('server/proposed/021_account_retirement.sql', 'utf8');
  await admin.query(retirement);
  await admin.query('INSERT INTO schema_migration(name,checksum) VALUES($1,$2)', [
    '021_account_retirement.sql',
    hash(retirement),
  ]);
  await admin.query('GRANT INSERT,UPDATE ON account_avatar TO ' + staff.username);
  await admin.query(
    'GRANT SELECT,DELETE ON material_operator,assessment_recorder TO ' + staff.username,
  );
  const designRoles = (
    await admin.query(
      `SELECT
    has_table_privilege($1,'owner_portal.project_design','INSERT') AS staff_write,
    has_table_privilege($2,'owner_portal.project_design','SELECT') AS owner_table,
    has_function_privilege($2,'owner_portal.authorized_design(text,text)','EXECUTE') AS owner_checked`,
      [staff.username, ownerDb.username],
    )
  ).rows[0];
  assert.deepEqual(designRoles, { staff_write: true, owner_table: false, owner_checked: true });
  const migrationRows = await admin.query(
    'SELECT filename,sha256 FROM owner_portal.purchase_migration ORDER BY filename COLLATE "C"',
  );
  assert.deepEqual(migrationRows.rows, [
    { filename: '017_owner_purchase.sql', sha256: hash(migration) },
    { filename: '017_owner_purchase_grants.sql', sha256: hash(grants) },
    { filename: '018_owner_purchase_evidence.sql', sha256: hash(evidence) },
    { filename: '018_owner_purchase_evidence_grants.sql', sha256: hash(evidenceGrants) },
  ]);
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_state,assignment,purchase,purchase_record,project,task,trade,memo,person TO ' +
      staff.username,
  );
  await admin.query(
    'GRANT SELECT,INSERT ON audit_event,purchase_action,workspace_history_revision TO ' +
      staff.username,
  );
  await admin.query(
    'GRANT SELECT,INSERT ON legacy_record_link,mention_notification TO ' + staff.username,
  );
  await admin.query('GRANT USAGE ON SEQUENCE mention_notification_id_seq TO ' + staff.username);
  await admin.query(
    'GRANT SELECT ON studio_daily,studio_daily_submission,work_record,record_history,daily_assessment,assessment_history,assessment_recorder,department,member_card TO ' +
      staff.username,
  );
  await admin.query('GRANT SELECT ON schema_migration TO ' + staff.username);
  await admin.query('GRANT INSERT,UPDATE ON studio_daily TO ' + staff.username);
  await admin.query('GRANT INSERT ON studio_daily_submission TO ' + staff.username);
  process.env.CHUNMO_OWNER_PORTAL_ENABLED = '1';
  process.env.CHUNMO_OWNER_PURCHASE_ENABLED = '1';
  process.env.CHUNMO_OWNER_DESIGN_ENABLED = '1';
  process.env.CHUNMO_OWNER_DESIGN_ORIGINS = 'https://design.example.com';
  t.after(() => {
    delete process.env.CHUNMO_OWNER_PORTAL_ENABLED;
    delete process.env.CHUNMO_OWNER_PURCHASE_ENABLED;
    delete process.env.CHUNMO_OWNER_DESIGN_ENABLED;
    delete process.env.CHUNMO_OWNER_DESIGN_ORIGINS;
  });

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
  process.env.CHUNMO_OWNER_WECHAT_APP_SECRET = 'synthetic-isolated-secret';
  t.after(() => {
    delete process.env.CHUNMO_OWNER_WECHAT_APP_SECRET;
  });
  const app = createApp({
    unifiedLogin: true,
    employeeWechat: {
      appId: 'wx1111111111111111',
      openId: async (code) => {
        if (code === 'invalid') throw new ApiError(401, '微信登录已失效，请重新授权');
        return code;
      },
      phone: async (code) => (code === 'different' ? '13900000028' : '13900000027'),
    },
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
  const artifacts = process.env.CHUNMO_OWNER_BROWSER_ARTIFACTS;
  if (artifacts || process.env.CHUNMO_V21_SCREENSHOTS) app.use(express.static('dist'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  const binding = server.address() as import('node:net').AddressInfo;
  const base = 'http://127.0.0.1:' + binding.port;
  const savedOrigin = config.APP_ORIGIN;
  config.APP_ORIGIN = base;
  t.after(() => {
    config.APP_ORIGIN = savedOrigin;
  });
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
        Origin: base,
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
  await t.test(
    'employee remembered sign-in uses a separate, WeChat-bound 30-day credential',
    async () => {
      const oldPassword = 'Test-monthly-2026!';
      const newPassword = 'Changed-monthly-2026!';
      await admin.query(
        "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES('monthly','w','monthly',$1,'employee')",
        [await passwordHash(oldPassword)],
      );
      const passwordLogin = async (password: string) => {
        const response = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: base },
          body: JSON.stringify({ login: 'monthly', password }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=28800/);
        return /chunmo_session=([a-f0-9]{64})/.exec(response.headers.get('set-cookie') ?? '')![1];
      };
      const call = (route: string, body: object, cookie = '', sendCsrf = true, referer = true) =>
        fetch(base + '/api/mini-employee/v1/' + route, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(referer
              ? { Referer: 'https://servicewechat.com/wx1111111111111111/0/page-frame.html' }
              : {}),
            ...(cookie ? { Cookie: 'chunmo_session=' + cookie } : {}),
            ...(cookie && sendCsrf ? { 'X-CSRF-Token': hash('csrf:' + cookie) } : {}),
          },
          body: JSON.stringify(body),
        });
      let cookie = await passwordLogin(oldPassword);
      const code = 'verified_employee_wx';
      assert.equal((await call('remember', { code }, cookie, false)).status, 403);
      const issued = await call('remember', { code }, cookie);
      assert.equal(issued.status, 200);
      const { token, expiresAt } = await issued.json();
      const remaining = Date.parse(expiresAt) - Date.now();
      assert(remaining > 29.99 * 86400000 && remaining <= 30 * 86400000);
      assert.equal((await request('/auth/session', 'GET', undefined, token)).status, 401);
      assert.equal((await call('resume', { code, token }, '', false, false)).status, 403);
      assert.equal((await call('resume', { code: 'other_wechat', token })).status, 401);
      await admin.query('DELETE FROM auth_session WHERE token_hash=$1', [hash(cookie)]);
      assert.equal((await request('/auth/session', 'GET', undefined, cookie)).status, 401);
      const restored = await call('resume', { code, token });
      assert.equal(restored.status, 200);
      const short = /chunmo_session=([a-f0-9]{64})/.exec(
        restored.headers.get('set-cookie') ?? '',
      )![1];
      assert.equal(
        (await request('/auth/session', 'GET', undefined, short)).body.user.id,
        'monthly',
      );
      assert.equal((await call('forget', { code, token })).status, 200);
      assert.equal((await call('resume', { code, token })).status, 401);
      const again = await call('remember', { code }, short);
      assert.equal(again.status, 200);
      const second = (await again.json()).token;
      const password = await request(
        '/auth/password',
        'POST',
        {
          currentPassword: oldPassword,
          newPassword,
          confirmPassword: newPassword,
        },
        short,
      );
      assert.equal(password.status, 200);
      assert.equal((await call('resume', { code, token: second })).status, 401);
      cookie = await passwordLogin(newPassword);
      const third = (await (await call('remember', { code }, cookie)).json()).token;
      await admin.query(
        "UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE account_id='monthly'",
      );
      assert.equal((await call('resume', { code, token: third })).status, 401);
    },
  );
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
  const ownerWindow = (
    await admin.query(
      'SELECT extract(epoch from expires_at-now()) AS seconds FROM owner_portal.session',
    )
  ).rows[0].seconds;
  assert(Number(ownerWindow) > 29.99 * 86400 && Number(ownerWindow) <= 30 * 86400);
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
  let evidencePhotoPath = '';
  await t.test(
    'existing and new purchases publish safely and synchronize through completion',
    async (purchaseTest) => {
      const original = {
        id: 'existing',
        projectId: 'p1',
        name: '内部采购',
        notes: 'PRIVATE-DETAIL',
        specification: '旧采购规格 A',
        quantity: '2 套',
        due: '2026-12-09',
        taskId: '',
        leadDays: 0,
        status: '待采购' as const,
        owner: 'PRIVATE-STAFF',
      };
      const fixtures = {
        ...emptyData(),
        projects: [
          { ...newProject(), id: 'p1', name: '一号住宅' },
          { ...newProject(), id: 'p2', name: '二号住宅' },
        ],
        purchases: [original],
      };
      await admin.query("INSERT INTO workspace_state VALUES('w',0,$1,$2)", [
        JSON.stringify(fixtures),
        JSON.stringify(emptyHistory()),
      ]);
      await admin.query("INSERT INTO purchase VALUES('w','existing','p1',NULL,$1)", [
        JSON.stringify(original),
      ]);
      await admin.query(
        `INSERT INTO owner_portal.purchase_collaboration
         (workspace_id,project_id,purchase_id,responsibility,published,title,description,specification,quantity,reference)
         VALUES ('w','p1','existing','supplier',false,$1,'旧对外说明','','','')`,
        [original.name],
      );
      await pool.query("UPDATE project SET payload=$1 WHERE workspace_id='w' AND id='p1'", [
        JSON.stringify(fixtures.projects[0]),
      ]);

      const desktop = '/owner-purchases/p1/existing';
      const phone = projects + '/p1/purchases';
      const postPhone = phone + '/existing/feedback';
      const feed = (p = phone, bearer = tokenA) => request(p, 'GET', undefined, '', bearer);
      const read = () =>
        request(desktop, 'GET', undefined, founder).then((r) => {
          assert.equal(r.status, 200, JSON.stringify(r.body));
          return r.body.item;
        });
      const change = (body: object, actor = founder) => request(desktop, 'POST', body, actor);
      const published = {
        responsibility: 'owner',
        published: true,
        title: '业主端灯具',
        description: '经确认的对外说明',
        specification: '规格 A',
        quantity: '2',
        reference: 'https://example.com/store',
      };
      const write = async (action: string, fields: object, actor = founder) =>
        change(
          { action, ...fields, version: (await read()).version, requestId: randomUUID() },
          actor,
        );
      assert.deepEqual((await feed()).body.items, []);
      assert.equal((await feed(phone, '')).status, 401);
      assert.equal((await feed(projects + '/p2/purchases', tokenB)).status, 404);
      assert.equal((await request(desktop, 'GET', undefined, '', tokenA)).status, 401);
      assert.equal((await request(desktop, 'GET', undefined, employee)).status, 403);
      assert.equal(
        (await request('/owner-purchases/secret/existing', 'GET', undefined, founder)).status,
        403,
      );
      assert.equal((await write('publication', { publication: published }, employee)).status, 403);
      assert.equal(
        (await write('publication', { publication: { ...published, responsibility: 'company' } }))
          .status,
        400,
      );
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        const { chromium, expect } = await import('@playwright/test');
        const browser = await chromium.launch({
          executablePath: '/usr/bin/chromium',
          args: ['--no-sandbox'],
        });
        try {
          const open = async (
            credential: string,
            width: number,
            reducedMotion: 'no-preference' | 'reduce',
          ) => {
            const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
            page.setDefaultTimeout(10000);
            await page
              .context()
              .addCookies([{ name: 'chunmo_session', value: credential, url: base + '/api' }]);
            await page.addInitScript(() => {
              sessionStorage.setItem('chunmo-space', 'cloud');
              // Keep the desktop editor mounted when exercising its CSS below the mobile switch.
              const match = window.matchMedia.bind(window);
              window.matchMedia = (query) =>
                query === '(max-width:700px), (pointer:coarse) and (max-width:1024px)'
                  ? match('(max-width: 0px)')
                  : match(query);
            });
            await page.goto(base);
            await page.getByRole('button', { name: '采购管理', exact: true }).click();
            await page.getByRole('button', { name: '编辑采购内部采购' }).click();
            return page;
          };
          const normal = await open(founder, 1440, 'no-preference');
          assert.equal(await normal.getByText('业主采购协同', { exact: true }).count(), 0);
          assert.equal(await normal.getByLabel('采购责任方').count(), 0);
          assert.equal(await normal.getByLabel('型号 / 规格').inputValue(), '旧采购规格 A');
          assert.equal(await normal.getByLabel('数量').inputValue(), '2 套');
          const checkbox = normal.getByRole('checkbox', { name: '业主可见' });
          await checkbox.check();
          await normal.getByLabel('采购说明（内部）').fill('PRIVATE-UPDATED');
          const inspectRow = async (page: typeof normal) => {
            const row = page.locator('.purchase-visibility-row');
            await row.scrollIntoViewIfNeeded();
            const boxes = await row.evaluate((node) => {
              const [left, right] = Array.from(node.children, (child) =>
                child.getBoundingClientRect(),
              );
              const status = node.querySelector('select')!.getBoundingClientRect();
              const toggle = node.querySelector('input')!.getBoundingClientRect();
              const panel = node.closest('dialog')!.getBoundingClientRect();
              const body = node.closest('.modal-body')!.getBoundingClientRect();
              return {
                metrics: [left, right, toggle, status].map((box) => box.toJSON()),
                sameLine:
                  Math.abs(left.y - right.y) <= 2 && Math.abs(left.height - right.height) <= 2,
                columns:
                  left.right <= right.left && left.left >= panel.left && right.right <= panel.right,
                controls:
                  Math.abs(toggle.y + toggle.height / 2 - status.y - status.height / 2) <= 2 &&
                  status.right <= right.right &&
                  toggle.right <= left.right,
                covered: left.top < body.top - 1 || right.bottom > body.bottom + 1,
                overflow: node.scrollWidth > node.clientWidth,
              };
            });
            const { metrics, ...checks } = boxes;
            assert.deepEqual(
              checks,
              { sameLine: true, columns: true, controls: true, covered: false, overflow: false },
              JSON.stringify(metrics),
            );
          };
          await inspectRow(normal);
          const mainSave = normal
            .locator('dialog')
            .getByRole('button', { name: '保存', exact: true });
          await mainSave.hover();
          await mainSave.focus();
          await normal.evaluate(() => document.fonts.ready);
          await normal.screenshot({ path: join(artifacts, '01-desktop-purchase-editor.png') });
          await mainSave.click();
          await normal.getByRole('heading', { name: '编辑采购事项' }).waitFor({ state: 'hidden' });
          assert.equal((await feed()).body.items[0].title, original.name);
          const savedWorkspace = (await request('/workspace', 'GET', undefined, founder)).body;
          assert.equal(
            savedWorkspace.data.purchases.find((row: { id: string }) => row.id === 'existing')
              .notes,
            'PRIVATE-UPDATED',
          );
          await normal.getByRole('button', { name: '新增采购', exact: true }).click();
          await normal.getByRole('heading', { name: '新建采购事项' }).waitFor();
          assert.equal(await normal.getByRole('checkbox', { name: '业主可见' }).isEnabled(), true);
          assert.equal(await normal.getByLabel('采购责任方').count(), 0);

          const pendingName = '待同步采购灯具';
          let releaseWorkspaceSave!: () => void;
          const holdWorkspaceSave = new Promise<void>((resolve) => {
            releaseWorkspaceSave = resolve;
          });
          const workspaceEndpoint = '**/api/workspace';
          await normal.route(workspaceEndpoint, async (route) => {
            if (route.request().method() === 'PUT') await holdWorkspaceSave;
            await route.continue();
          });
          const submitting = normal.waitForRequest(
            (r) => r.url().endsWith('/api/workspace') && r.method() === 'PUT',
          );
          try {
            await normal.getByLabel('采购名称').fill(pendingName);
            await mainSave.click();
            await submitting;
            await normal.getByRole('button', { name: '编辑采购' + pendingName }).click();
            const waitingVisibility = normal.getByRole('checkbox', { name: '业主可见' });
            await waitingVisibility.check();
            assert.equal(
              await normal.getByText('采购尚未保存或已移除', { exact: true }).count(),
              0,
            );
            assert.ok(
              !(await feed()).body.items.some(
                (row: { title: string }) => row.title === pendingName,
              ),
            );
            await waitingVisibility.scrollIntoViewIfNeeded();
            await normal.screenshot({
              path: join(artifacts, '04-pending-purchase-visibility.png'),
            });
            await mainSave.click();
          } finally {
            releaseWorkspaceSave();
          }
          await normal.getByRole('heading', { name: '编辑采购事项' }).waitFor({ state: 'hidden' });
          assert.equal(
            (await feed()).body.items.filter((row: { title: string }) => row.title === pendingName)
              .length,
            1,
          );
          await normal.unroute(workspaceEndpoint);
          const visibleNames = [
            '测试采购三',
            '测试采购四',
            '测试采购五',
            '测试采购六',
            '测试采购七',
          ];
          const privateName = '测试未发布采购';
          for (const [index, name] of [...visibleNames, privateName].entries()) {
            await normal.getByRole('button', { name: '新增采购', exact: true }).click();
            await normal.getByRole('heading', { name: '新建采购事项' }).waitFor();
            await normal.getByLabel('采购名称').fill(name);
            const visibility = normal.getByRole('checkbox', { name: '业主可见' });
            assert.equal(await visibility.isChecked(), false);
            if (name !== privateName) await visibility.check();
            else {
              await normal.locator('dialog').getByLabel('采购状态').selectOption('已下单');
              await normal.locator('dialog').getByLabel('品牌', { exact: true }).fill('内部品牌');
              await normal.locator('dialog').getByLabel('型号', { exact: true }).fill('内部型号');
            }
            await normal.getByText('本地已保存，待提交', { exact: true }).waitFor();
            await mainSave.click();
            await normal.locator('dialog').waitFor({ state: 'hidden' });
            await normal.getByRole('button', { name: '编辑采购' + name }).waitFor();
            const delivered = (await feed()).body.items.map(
              ({ title }: { title: string }) => title,
            );
            assert.deepEqual(
              delivered.sort(),
              [original.name, pendingName, ...visibleNames.slice(0, index + 1)].sort(),
            );
          }
          const statusName = visibleNames[0];
          const changedCard = normal.getByRole('combobox', { name: '采购状态' + statusName });
          const phoneItem = async () =>
            (await feed()).body.items.find(({ title }: { title: string }) => title === statusName);
          await expect(changedCard.locator('option')).toHaveText(['待采购', '已下单', '已到货']);
          await changedCard.selectOption('已到货');
          const arrived = normal.getByRole('dialog', { name: '标为已到货' });
          await expect(arrived.getByText('请先填写品牌和型号并确认下单。')).toBeVisible();
          await arrived.getByRole('button', { name: '取消', exact: true }).click();
          await expect(changedCard).toHaveValue('待采购');
          await changedCard.selectOption('已下单');
          const ordered = normal.getByRole('dialog', { name: '标为已下单' });
          const confirmOrder = ordered.getByRole('button', { name: '确认', exact: true });
          await ordered.getByLabel('型号').fill('测试型号');
          await expect(confirmOrder).toBeDisabled();
          await ordered.getByLabel('品牌').fill('测试品牌');
          await ordered.screenshot({ path: join(artifacts, '05-confirm-order.png') });
          await confirmOrder.click();
          await expect(changedCard).toHaveValue('已下单');
          assert.equal((await phoneItem()).state, 'bought');
          await changedCard.selectOption('已到货');
          await expect(arrived.getByText('确认这项采购已到货？')).toBeVisible();
          await expect(arrived.getByLabel('品牌')).toHaveCount(0);
          await expect(arrived.getByLabel('型号')).toHaveCount(0);
          await arrived.screenshot({ path: join(artifacts, '06-confirm-arrival.png') });
          await arrived.getByRole('button', { name: '确认', exact: true }).focus();
          await normal.keyboard.press('Enter');
          await expect(arrived).toBeHidden();
          await expect(changedCard).toHaveValue('已到货');
          assert.equal((await phoneItem()).state, 'complete');
          assert.equal((await phoneItem()).feedback.brand, '测试品牌');
          await changedCard.selectOption('待采购');
          const reopen = normal.getByRole('dialog', { name: '标为待采购' });
          await expect(reopen.getByRole('button', { name: '确认', exact: true })).toBeDisabled();
          await reopen.getByLabel('对外说明').fill('测试重新采购');
          await normal.setViewportSize({ width: 390, height: 844 });
          await expect
            .poll(async () => {
              const bounds = await reopen.boundingBox();
              return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390;
            })
            .toBe(true);
          await reopen.screenshot({ path: join(artifacts, '07-confirm-reopen.png') });
          await reopen.getByRole('button', { name: '确认', exact: true }).click();
          await expect(reopen).toBeHidden();
          await expect(changedCard).toHaveValue('待采购');
          assert.equal((await phoneItem()).state, 'pending');
          assert.equal((await phoneItem()).feedback.model, '测试型号');
          assert.equal((await phoneItem()).returnReason, '测试重新采购');
          await normal.close();
          const savedPending = (await request('/workspace', 'GET', undefined, founder)).body;
          const browserNames = new Set([pendingName, ...visibleNames, privateName]);
          assert.equal(savedPending.data.purchases.length, browserNames.size + 1);
          const privateOrder = savedPending.data.purchases.find(
            (p: { name: string }) => p.name === privateName,
          );
          assert.equal(privateOrder.status, '已下单');
          const privateFeedback = (
            await request('/owner-purchases/p1/' + privateOrder.id, 'GET', undefined, founder)
          ).body.item;
          assert.equal(privateFeedback.published, false);
          assert.equal(privateFeedback.brand, '内部品牌');
          assert.equal(privateFeedback.model, '内部型号');
          // Keep the fixture set for the remaining cases unchanged.
          const cleanup = await request(
            '/workspace',
            'PUT',
            {
              revision: savedPending.revision,
              data: {
                ...savedPending.data,
                purchases: savedPending.data.purchases.filter(
                  (row: { name: string }) => !browserNames.has(row.name),
                ),
              },
            },
            founder,
          );
          assert.equal(cleanup.status, 200, JSON.stringify(cleanup.body));

          const alias = await write('publication', {
            publication: {
              ...published,
              title: '789',
              description: '旧对外说明',
              specification: original.specification,
              quantity: original.quantity,
            },
          });
          assert.equal(alias.status, 200, JSON.stringify(alias.body));
          assert.equal((await feed()).body.items[0].title, '789');
          const narrow = await open(founder, 760, 'reduce');
          await narrow.getByRole('checkbox', { name: '业主可见' }).waitFor();
          await inspectRow(narrow);
          await narrow.screenshot({ path: join(artifacts, '02-narrow-purchase-editor.png') });
          await narrow.setViewportSize({ width: 390, height: 844 });
          await inspectRow(narrow);
          await narrow.screenshot({ path: join(artifacts, '03-compact-purchase-editor.png') });
          await narrow.getByRole('button', { name: '选择最迟采购日期' }).click();
          await narrow.locator('.calendar-popover:popover-open').waitFor();
          await narrow.keyboard.press('Escape');
          await narrow.locator('.calendar-popover:popover-open').waitFor({ state: 'hidden' });
          // Saving an unchanged, already visible editor repairs its stale public title.
          await narrow.locator('dialog').getByRole('button', { name: '保存', exact: true }).click();
          await narrow.getByRole('heading', { name: '编辑采购事项' }).waitFor({ state: 'hidden' });
          assert.equal((await feed()).body.items[0].title, original.name);
          await narrow.close();
          const lowMotion = await open(founder, 1280, 'reduce');
          await lowMotion.getByRole('button', { name: '代为确认购买' }).click();
          await lowMotion.getByLabel('购买备注').fill('测试商品链接 https://example.com/item');
          await lowMotion.getByLabel('购买备注').focus();
          assert.equal(
            await lowMotion
              .getByLabel('购买备注')
              .evaluate((node) => getComputedStyle(node).filter),
            'none',
          );
          await lowMotion.screenshot({ path: join(artifacts, '02-desktop-purchase-feedback.png') });
          await lowMotion.getByRole('button', { name: '取消', exact: true }).last().click();
          await lowMotion.goto(base);
          await lowMotion.context().grantPermissions(['clipboard-read', 'clipboard-write']);
          await lowMotion
            .getByRole('button', { name: /编辑当前项目|编辑项目一号住宅/ })
            .first()
            .click();
          const accessPanel = lowMotion.locator('dialog .owner-access');
          await accessPanel.getByText('业主授权', { exact: true }).click();
          await accessPanel.getByLabel('业主称呼').fill('邀请口令验收');
          await accessPanel.getByLabel('业主手机号', { exact: true }).fill('13900000009');
          await accessPanel.getByRole('button', { name: '授权并生成邀请' }).click();
          const inviteField = accessPanel.getByLabel('一次性邀请口令（24 小时有效）');
          const code = await inviteField.inputValue();
          assert.match(code, /^[a-f0-9]{64}$/);
          await accessPanel.getByRole('button', { name: '复制邀请口令' }).click();
          assert.equal(await lowMotion.evaluate(() => navigator.clipboard.readText()), code);
          const pathField = accessPanel.getByLabel('开发工具邀请路径');
          assert.equal(
            await pathField.inputValue(),
            'owner-login/pages/welcome/index?invite=' + code,
          );
          await pathField.scrollIntoViewIfNeeded();
          await lowMotion.locator('dialog').screenshot({
            path: join(artifacts, '08-owner-invitation.png'),
            mask: [inviteField, pathField],
            maskColor: '#e8ebe4',
          });
          await accessPanel
            .locator('.owner-access-member')
            .filter({ hasText: '邀请口令验收' })
            .getByRole('button', { name: '撤销本项目授权' })
            .click();
          await lowMotion.close();
          const limited = await open(employee, 1280, 'no-preference');
          assert.equal(await limited.getByText('业主采购协同', { exact: true }).count(), 0);
          assert.equal(await limited.getByRole('checkbox', { name: '业主可见' }).count(), 0);
          await limited.close();
        } finally {
          await browser.close();
        }
      } else {
        const workspace = (await request('/workspace', 'GET', undefined, founder)).body;
        assert.equal(
          (await write('edit', { revision: workspace.revision, publication: { visible: true } }))
            .status,
          200,
        );
      }
      await admin.query("INSERT INTO project_permission VALUES('w','p1','employee',true)");
      assert.equal((await request(desktop, 'GET', undefined, employee)).status, 200);
      assert.equal((await request(staffApi(), 'GET', undefined, employee)).status, 403);
      assert.equal(
        (await request('/owner-purchases/p2/existing', 'GET', undefined, employee)).status,
        403,
      );
      let record = (await feed()).body.items[0];
      assert.equal(record.title, original.name);
      assert.equal(record.specification, original.specification);
      assert.equal(record.quantity, original.quantity);
      assert.equal(record.due, original.due);
      assert.equal(record.description, '旧对外说明');
      assert.equal(record.state, 'pending');
      assert.ok(!JSON.stringify(record).includes('PRIVATE-'));
      assert.deepEqual(Object.keys(record).sort(), [
        'description',
        'due',
        'feedback',
        'id',
        'quantity',
        'reference',
        'returnReason',
        'specification',
        'state',
        'title',
        'version',
      ]);
      assert.equal((await write('finish', {})).status, 409);
      const confirm = {
        action: 'purchase',
        requestId: randomUUID(),
        version: record.version,
        feedback: { brand: '品牌', model: 'A-01', note: 'https://example.com/item' },
      };
      const respond = (body: object, bearer = tokenA, route = postPhone) =>
        request(route, 'POST', body, '', bearer);
      assert.equal(
        (await respond({ ...confirm, feedback: { ...confirm.feedback, brand: '' } })).status,
        400,
      );
      assert.equal(
        (await respond(confirm, tokenB, projects + '/p2/purchases/existing/feedback')).status,
        404,
      );
      const otherConfirm = { ...confirm, requestId: randomUUID() };
      const competing = await Promise.all([respond(confirm), respond(otherConfirm, tokenB)]);
      assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
      const firstWon = competing[0].status === 200;
      assert.equal(
        (await respond(firstWon ? confirm : otherConfirm, firstWon ? tokenA : tokenB)).status,
        200,
      );
      assert.equal((await read()).model, 'A-01');
      record = (await feed()).body.items[0];
      assert.equal(record.state, 'bought');
      const withdraw = { action: 'withdraw', requestId: randomUUID(), version: record.version };
      assert.equal((await respond(withdraw)).status, 200);
      assert.equal((await respond(withdraw)).status, 200);
      assert.equal((await feed()).body.items[0].state, 'pending');
      assert.equal((await write('purchase', { feedback: confirm.feedback }, employee)).status, 200);
      assert.equal((await read()).feedbackActor, 'employee');
      assert.equal((await write('return', { reason: '请重新核对尺寸' }, employee)).status, 200);
      record = (await feed()).body.items[0];
      assert.equal(record.returnReason, '请重新核对尺寸');
      assert.equal(
        (await respond({ ...confirm, requestId: randomUUID(), version: record.version })).status,
        200,
      );
      const beforeHide = (await request('/workspace', 'GET', undefined, founder)).body;
      const hide = {
        action: 'edit',
        requestId: randomUUID(),
        revision: beforeHide.revision,
        version: (await read()).version,
        publication: { visible: false },
      };
      assert.equal((await change(hide, employee)).status, 200);
      assert.equal((await change(hide, employee)).status, 200);
      assert.equal((await change({ ...hide, requestId: randomUUID() }, employee)).status, 409);
      assert.equal((await read()).model, 'A-01');
      assert.equal(
        (await request('/workspace', 'GET', undefined, founder)).body.revision,
        beforeHide.revision,
      );
      assert.deepEqual((await feed()).body.items, []);
      assert.equal((await respond(withdraw)).status, 404);
      assert.equal((await write('publication', { publication: published })).status, 200);
      assert.equal((await feed()).body.items[0].title, published.title);
      const dbState = (await request('/workspace', 'GET', undefined, founder)).body;
      const syncName = await write('edit', {
        revision: dbState.revision,
        publication: { visible: true },
      });
      assert.equal(syncName.status, 200, JSON.stringify(syncName.body));
      const syncedItem = (await feed()).body.items[0];
      assert.equal(syncedItem.title, original.name);
      assert.equal(syncedItem.state, 'bought');
      assert.equal(syncedItem.feedback.model, 'A-01');
      assert.equal(syncedItem.description, published.description);
      assert.equal(syncName.body.workspace.revision, dbState.revision);
      const updated = await request(
        '/workspace',
        'PUT',
        {
          revision: dbState.revision,
          data: {
            ...dbState.data,
            purchases: [{ ...dbState.data.purchases[0], due: '2026-12-08' }],
          },
        },
        founder,
      );
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal((await feed()).body.items[0].due, '2026-12-08');
      assert.equal((await feed()).body.items[0].state, 'bought');
      const done = await write('finish', {}, employee);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      record = (await feed()).body.items[0];
      assert.equal(record.state, 'complete');
      assert.equal(
        (await respond({ ...confirm, requestId: randomUUID(), version: record.version })).status,
        409,
      );
      assert.equal((await write('reopen', { reason: '计划变更' }, employee)).status, 403);
      const reopened = await write('reopen', { reason: '计划变更' });
      assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
      assert.equal((await feed()).body.items[0].state, 'pending');

      const canonical = (await request('/workspace', 'GET', undefined, founder)).body;
      const creation = {
        action: 'create',
        requestId: randomUUID(),
        revision: canonical.revision,
        purchase: { ...original, id: 'new-purchase', name: '第二笔', status: '已完成' },
        publication: { visible: true },
      };
      const endpoint = '/owner-purchases/p1/new-purchase';
      const created = await request(endpoint, 'POST', creation, founder);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      assert.ok(
        created.body.workspace.data.purchases.some((p: { id: string }) => p.id === 'new-purchase'),
      );
      assert.equal((await request(endpoint, 'POST', creation, founder)).status, 200);
      const both = (await feed()).body.items;
      assert.equal(both.length, 2);
      assert.equal(
        both.find((item: { id: string }) => item.id === 'new-purchase').state,
        'complete',
      );
      for (const table of [
        'owner_portal.purchase_collaboration',
        'owner_portal.purchase_staff',
        'owner_portal.purchase_event',
      ])
        await assert.rejects(
          () => runtime.query('SELECT * FROM ' + table),
          (error: any) => error.code === '42501',
        );
      await assert.rejects(() =>
        admin.query("DELETE FROM owner_portal.purchase_event WHERE workspace_id='w'"),
      );
      await pool.query("DELETE FROM purchase WHERE workspace_id='w' AND id='new-purchase'");
      await admin.query("INSERT INTO purchase VALUES('w','new-purchase','p1',NULL,$1)", [
        JSON.stringify(creation.purchase),
      ]);
      assert.equal((await feed()).body.items.length, 1);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM owner_portal.purchase_event WHERE workspace_id='w' AND purchase_id IN ('existing','new-purchase')",
          )
        ).rows[0].count,
        artifacts ? 14 : 12,
      );
      const originalImage = await sharp({
        create: { width: 48, height: 32, channels: 3, background: '#728c62' },
      })
        .png()
        .withMetadata({ exif: { IFD0: { Artist: 'PRIVATE-IMAGE-METADATA' } } })
        .toBuffer();
      const photoRequest = {
        action: 'purchase',
        requestId: randomUUID(),
        version: (await feed()).body.items[0].version,
        feedback: {
          brand: '示例品牌',
          model: 'A-18',
          note: '示例图片反馈',
          link: 'HTTPS://example.com/item?sku=18',
          image: originalImage.toString('base64'),
        },
      };
      await purchaseTest.test(
        'purchase link and private JPEG synchronize and retain an exact retry receipt',
        async () => {
          assert.equal(
            (
              await respond({
                ...photoRequest,
                feedback: { ...photoRequest.feedback, link: 'https://user:pwd@example.com/item' },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await respond({
                ...photoRequest,
                feedback: {
                  ...photoRequest.feedback,
                  image: Buffer.from('not an image').toString('base64'),
                },
              })
            ).status,
            400,
          );
          const rivalPhoto = {
            ...photoRequest,
            requestId: randomUUID(),
            feedback: { ...photoRequest.feedback, note: '并发反馈' },
          };
          const raced = await Promise.all([respond(photoRequest), respond(rivalPhoto)]);
          assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
          const accepted = raced[0].status === 200 ? photoRequest : rivalPhoto;
          const visible = (await feed()).body.items[0];
          assert.equal(visible.feedback.link, 'https://example.com/item?sku=18');
          assert.equal(visible.feedback.brand, '示例品牌');
          assert.match(visible.feedback.imageId, /^[a-f0-9]{64}$/);
          const imageId = visible.feedback.imageId;
          evidencePhotoPath = phone + '/existing/photo/' + imageId;
          if (accepted) {
            assert.equal((await respond(accepted)).status, 200);
            assert.equal(
              (
                await respond({
                  ...accepted,
                  feedback: { ...accepted.feedback, link: 'https://example.com/different' },
                })
              ).status,
              409,
            );
          }
          assert.equal((await read()).link, visible.feedback.link);
          assert.equal((await read()).imageId, imageId);
          const ownerPhoto = await request(evidencePhotoPath, 'GET', undefined, '', tokenA);
          assert.equal(ownerPhoto.status, 200);
          assert.equal((await request(evidencePhotoPath)).status, 401);
          assert.equal(
            (await request(evidencePhotoPath.replace('/p1/', '/p2/'), 'GET', undefined, '', tokenA))
              .status,
            404,
          );
          assert.equal(
            (
              await request(
                evidencePhotoPath.replace('/existing/', '/new-purchase/'),
                'GET',
                undefined,
                '',
                tokenA,
              )
            ).status,
            404,
          );
          const staffPhoto = await request(
            desktop + '/photo/' + imageId,
            'GET',
            undefined,
            founder,
          );
          assert.equal(staffPhoto.status, 200);
          assert.equal(staffPhoto.body.image, ownerPhoto.body.image);
          const meta = await sharp(Buffer.from(ownerPhoto.body.image, 'base64')).metadata();
          assert.equal(meta.format, 'jpeg');
          assert.equal(meta.exif, undefined);
          const events = (
            await admin.query(
              `
          SELECT input,before_value,after_value FROM owner_portal.purchase_event
          WHERE actor_kind='owner' AND purchase_id='existing' AND input#>>'{feedback,imageId}'=$1
        `,
              [imageId],
            )
          ).rows;
          assert.equal(events.length, 1);
          assert.ok(!JSON.stringify(events).includes(ownerPhoto.body.image));
          assert.equal(
            (await admin.query('SELECT count(*)::int n FROM owner_portal.purchase_feedback_photo'))
              .rows[0].n,
            1,
          );
          await assert.rejects(
            () => runtime.query('SELECT jpeg FROM owner_portal.purchase_feedback_photo'),
            (error: any) => error.code === '42501',
          );
          const replacement = await write('purchase', {
            feedback: {
              brand: '公司代确认',
              model: '005',
              note: '公司核对',
              link: visible.feedback.link,
            },
          });
          assert.equal(replacement.status, 200);
          assert.equal(replacement.body.item.imageId, imageId);
          assert.equal((await feed()).body.items[0].feedback.brand, '公司代确认');
          assert.equal(
            (await write('publication', { publication: { ...published, published: false } }))
              .status,
            200,
          );
          assert.equal(
            (await request(evidencePhotoPath, 'GET', undefined, '', tokenA)).status,
            404,
          );
          assert.equal((await write('publication', { publication: published })).status, 200);
          assert.equal(
            (await request(evidencePhotoPath, 'GET', undefined, '', tokenA)).status,
            200,
          );
          const activePhoto = (await feed()).body.items[0];
          const removed = {
            ...photoRequest,
            requestId: randomUUID(),
            version: activePhoto.version,
            feedback: { ...photoRequest.feedback, brand: '公司代确认', image: '' },
          };
          assert.equal((await respond(removed)).status, 200);
          assert.equal(
            (await request(evidencePhotoPath, 'GET', undefined, '', tokenA)).status,
            404,
          );
          assert.equal((await read()).imageId, null);
          assert.equal(
            (
              await respond({
                ...removed,
                requestId: randomUUID(),
                version: (await feed()).body.items[0].version,
                feedback: { ...removed.feedback, image: photoRequest.feedback.image },
              })
            ).status,
            200,
          );
          assert.equal(
            (await request(evidencePhotoPath, 'GET', undefined, '', tokenA)).status,
            200,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int n FROM owner_portal.purchase_feedback_photo'))
              .rows[0].n,
            1,
          );
          if (artifacts) {
            const { chromium, expect } = await import('@playwright/test');
            const browser = await chromium.launch({
              executablePath: '/usr/bin/chromium',
              args: ['--no-sandbox'],
            });
            try {
              const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
              await page
                .context()
                .addCookies([{ name: 'chunmo_session', value: founder, url: base + '/api' }]);
              await page.addInitScript(() => sessionStorage.setItem('chunmo-space', 'cloud'));
              await page.goto(base);
              await page.getByRole('button', { name: '采购管理', exact: true }).click();
              await page.getByRole('button', { name: '编辑采购内部采购' }).click();
              const modal = page.getByRole('dialog');
              await expect(modal.getByText(visible.feedback.link, { exact: false })).toBeVisible();
              await modal.getByRole('button', { name: '查看购买图片' }).click();
              await expect(modal.getByRole('img', { name: '业主购买图片' })).toBeVisible();
              assert.ok(
                await modal
                  .getByRole('img', { name: '业主购买图片' })
                  .evaluate(
                    (img) =>
                      img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
                  ),
              );
              await modal.screenshot({ path: join(artifacts, 'owner-005-desktop-feedback.png') });
            } finally {
              await browser.close();
            }
          }
        },
      );
    },
  );
  await t.test(
    'unified WeChat login, canonical claims, independent sessions, binding conflicts and permission revocation',
    async () => {
      const browserAssets = process.env.CHUNMO_V21_SCREENSHOTS;
      const pwd = 'Test-unified-2026!';
      await admin.query(
        "INSERT INTO account(id,workspace_id,login,password_hash,role,display_name) VALUES('unified-user','w','unified-user',$1,'employee','秦实'),('another-user','w','another-user',$1,'employee','周审')",
        [await passwordHash(pwd)],
      );
      const call = async (path: string, input: object, referer = true) => {
        const response = await fetch(base + '/api/mini-login/v1/' + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(referer
              ? { Referer: 'https://servicewechat.com/wx1111111111111111/0/page-frame.html' }
              : {}),
          },
          body: JSON.stringify(input),
        });
        return {
          status: response.status,
          body: await response.json(),
          cookie: (/chunmo_session=([a-f0-9]{64})/.exec(response.headers.get('set-cookie') ?? '') ??
            [])[1],
        };
      };
      const which = async (code: string) => (await call('discover', { code })).body.roles;
      const target = '/accounts/unified-user/wechat';
      assert.equal((await request('/accounts/wechat', 'GET', undefined, employee)).status, 403);
      assert.equal((await request('/owner-accounts', 'GET', undefined, employee)).status, 403);
      assert.equal((await call('discover', { code: 'demo_a' }, false)).status, 403);
      assert.equal((await call('discover', { code: 'invalid' })).status, 401);
      assert.equal((await call('discover', { code: 'demo_a', role: 'employee' })).status, 400);
      assert.deepEqual(await which('demo_a'), ['owner']);
      assert.deepEqual(await which('stranger'), []);
      assert.equal((await call('enter', { code: 'stranger', role: 'employee' })).status, 403);
      assert.equal((await call('enter', { code: 'stranger', role: 'owner' })).status, 403);
      assert.equal(
        (await request(target, 'PUT', { action: 'set-phone', phone: '13900000027' }, founder))
          .status,
        200,
      );
      assert.equal(
        (
          await request(
            '/accounts/another-user/wechat',
            'PUT',
            { action: 'set-phone', phone: '13900000027' },
            founder,
          )
        ).status,
        409,
      );
      const attrs = { code: 'demo_a', phoneCode: 'valid', login: 'unified-user', password: pwd };
      assert.equal(
        (await call('bind-employee', { ...attrs, password: 'Wrong-password' })).status,
        401,
      );
      assert.equal((await call('bind-employee', { ...attrs, phoneCode: 'different' })).status, 409);
      const staffResult = await call('bind-employee', attrs);
      assert.equal(staffResult.status, 200, JSON.stringify(staffResult.body));
      assert.ok(staffResult.cookie);
      assert.equal(
        (await request('/auth/session', 'GET', undefined, staffResult.cookie)).body.user.id,
        'unified-user',
      );
      assert.deepEqual(await which('demo_a'), ['employee', 'owner']);
      await admin.query(
        "INSERT INTO department(id,workspace_id,name,english_name,active) VALUES('design-dept','w','设计部','',true)",
      );
      await admin.query(
        "INSERT INTO member_card(workspace_id,account_id,english_name,department_id,job_title) VALUES('w','unified-user','','design-dept','主案设计师')",
      );
      const miniProfileUrl = base + '/api/mini-employee/v1/profile';
      const employeeProfile = await fetch(miniProfileUrl, {
        headers: {
          Referer: 'https://servicewechat.com/wx1111111111111111/0/page-frame.html',
          Cookie: 'chunmo_session=' + staffResult.cookie,
        },
      });
      assert.equal(employeeProfile.status, 200);
      assert.deepEqual(await employeeProfile.json(), {
        name: '秦实',
        department: '设计部',
        jobTitle: '主案设计师',
      });
      assert.equal((await fetch(miniProfileUrl)).status, 403);
      const gatewayHeaders = {
        'Content-Type': 'application/json',
        Referer: 'https://servicewechat.com/wx1111111111111111/0/page-frame.html',
      };
      const gateway = base + '/api/mini-photo-candidate/';
      const proofReply = await fetch(gateway + 'bootstrap', {
        method: 'POST',
        headers: gatewayHeaders,
        body: JSON.stringify({ code: 'demo_a' }),
      });
      assert.equal(proofReply.status, 200);
      const proof = (await proofReply.json()).proof;
      const signed = { ...gatewayHeaders, 'X-Chunmo-Mini-Proof': proof };
      assert.equal((await fetch(gateway + 'workbench/workspace', { headers: signed })).status, 401);
      const records = await fetch(gateway + 'workbench/records', {
        headers: { ...signed, Cookie: 'chunmo_session=' + staffResult.cookie },
      });
      assert.equal(records.status, 200);
      assert.equal(
        (
          await fetch(gateway + 'workbench/workspace', {
            method: 'PUT',
            headers: { ...signed, Cookie: 'chunmo_session=' + staffResult.cookie },
            body: JSON.stringify({
              protocol: 3,
              changes: [{ collection: 'projects', kind: 'record', after: {} }],
            }),
          })
        ).status,
        400,
      );

      assert.equal(
        (await call('bind-employee', { ...attrs, code: 'other', login: 'another-user' })).status,
        409,
      );
      const ownerResult = await call('enter', { code: 'demo_a', role: 'owner' });
      assert.equal(ownerResult.status, 200);
      assert.equal(ownerResult.cookie, undefined);
      assert.equal(
        (await request('/auth/session', 'GET', undefined, ownerResult.body.token)).status,
        401,
      );
      assert.equal(
        (await request(projects, 'GET', undefined, '', staffResult.body.remembered.token)).status,
        401,
      );
      const listing = await request('/owner-accounts', 'GET', undefined, founder);
      assert.equal(listing.status, 200);
      assert.equal(
        listing.body.members.find((r: { name: string }) => r.name === '甲').projects.length,
        2,
      );
      assert.ok(!JSON.stringify(listing).includes('13900000001'));
      assert.equal(
        (
          await request(
            staffApi('p2') + '/members',
            'POST',
            { name: '其他人', phone: '13900000001', create: true },
            founder,
          )
        ).status,
        409,
      );
      const perm = '/accounts/unified-user/project-permissions';
      assert.equal(
        (await request(perm, 'PUT', { project: 'p2', granted: true }, employee)).status,
        403,
      );
      assert.equal(
        (await request(perm, 'PUT', { project: 'secret', granted: true }, founder)).status,
        404,
      );
      assert.equal(
        (await request(perm, 'PUT', { project: 'p2', granted: true }, founder)).status,
        200,
      );
      assert.equal(
        (await request(perm, 'GET', undefined, founder)).body.projects.find(
          (p: { id: string }) => p.id === 'p2',
        ).granted,
        true,
      );
      assert.equal(
        (await request(perm, 'PUT', { project: 'p2', granted: false }, founder)).status,
        200,
      );

      assert.deepEqual(
        (await request('/auth/wechat-binding', 'GET', undefined, staffResult.cookie)).body,
        { phoneSuffix: '0027', bound: true },
      );
      assert.deepEqual((await request('/auth/wechat-binding', 'GET', undefined, employee)).body, {
        phoneSuffix: null,
        bound: false,
      });
      assert.equal((await request('/auth/wechat-binding')).status, 401);

      if (browserAssets) {
        await admin.query(`
          INSERT INTO account(id,workspace_id,login,password_hash,role,display_name)
          SELECT 'layout-user-' || n,'w','layout-user-' || n,a.password_hash,'employee',
            '联调员工 ' || lpad(n::text,2,'0')
          FROM generate_series(1,12) n JOIN account a ON a.id='unified-user'
        `);
        for (let n = 0; n < 12; n++) {
          const fixture = await request(
            staffApi() + '/members',
            'POST',
            {
              name: '联调业主 ' + String(n + 1).padStart(2, '0'),
              phone: '139006000' + String(n).padStart(2, '0'),
            },
            founder,
          );
          assert.equal(fixture.status, 200);
        }
        const { chromium, expect } = await import('@playwright/test');
        await mkdir(browserAssets, { recursive: true });
        const browser = await chromium.launch({
          executablePath: '/usr/bin/chromium',
          args: ['--no-sandbox'],
        });
        try {
          async function open(
            token: string,
            width: number,
            height: number,
            reducedMotion: 'reduce' | 'no-preference',
            legacy = false,
          ) {
            const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
            await page
              .context()
              .addCookies([{ name: 'chunmo_session', value: token, url: base + '/api' }]);
            await page.addInitScript(() => sessionStorage.setItem('chunmo-space', 'cloud'));
            await page.goto(legacy ? base + '/?ui=legacy' : base);
            const trigger = page.getByRole('button', { name: '账号管理', exact: true });
            await trigger.waitFor();
            await trigger.click();
            return page;
          }
          function panel(page: import('@playwright/test').Page) {
            const shell = page.getByRole('dialog', { name: '账号管理', exact: true });
            const primary = shell.getByRole('tablist', { name: '账号管理功能' });
            const secondary = shell.getByRole('tablist', { name: '账号分类' });
            const dir = shell.locator('.account-directory');
            const frame = () =>
              shell.evaluate((node) => {
                const [shell, menu, footer] = [
                  node,
                  node.querySelector('.account-tabs')!,
                  node.querySelector(':scope > .modal-foot')!,
                ].map((element) => {
                  const b = element.getBoundingClientRect();
                  return [b.x, b.y, b.width, b.height];
                });
                return {
                  shell,
                  menu,
                  footer,
                  radius: getComputedStyle(node).borderRadius,
                  animation: getComputedStyle(node).animationName,
                };
              });
            return { shell, primary, secondary, dir, frame };
          }
          const page = await open(founder, 1440, 920, 'no-preference');
          const { shell, primary, secondary, dir, frame } = panel(page);
          await expect(primary.getByRole('tab')).toHaveText(['账号管理', '个人中心']);
          await expect(secondary.getByRole('tab')).toHaveText(['员工账号', '业主账号']);
          const original = await frame();
          assert.deepEqual(original.shell, [160, 80, 1120, 760]);
          assert.equal(original.animation, 'none');
          const unchanged = async () => expect.poll(frame).toEqual(original);
          const rows = dir.locator('tbody tr');
          const scroll = dir.getByLabel('账号列表滚动区');
          const heading = dir.getByRole('columnheader', { name: '姓名' });
          const pagination = dir.getByLabel('账号列表分页');
          const search = dir.getByRole('searchbox');
          const screenshot = async (name: string) =>
            shell.screenshot({ path: join(browserAssets, name) });
          await expect(rows).toHaveCount(10);
          await expect(pagination).toContainText('共 17 条');
          await expect(pagination).toContainText('1 / 2');
          await expect(dir.getByRole('button', { name: '上一页' })).toBeDisabled();
          const startHead = await heading.boundingBox();
          const startPager = await pagination.boundingBox();
          const startRow = await rows.first().boundingBox();
          assert.ok(startHead && startPager && startRow);
          await scroll.hover();
          await page.mouse.wheel(0, 420);
          await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          assert.deepEqual(await heading.boundingBox(), startHead);
          assert.deepEqual(await pagination.boundingBox(), startPager);
          assert.ok((await rows.first().boundingBox())!.y < startRow.y);
          await unchanged();
          await screenshot('01-员工列表-滚动.png');
          await dir.getByRole('button', { name: '下一页' }).click();
          await expect(rows).toHaveCount(7);
          await expect(pagination).toContainText('2 / 2');
          await expect(dir.getByRole('button', { name: '下一页' })).toBeDisabled();
          await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(0);
          await screenshot('02-员工列表-第二页.png');
          await search.fill('无效筛选');
          await expect(rows).toHaveCount(0);
          await expect(pagination).toContainText('共 0 条');
          await expect(pagination).toContainText('0 / 0');
          await unchanged();
          await search.fill('秦实');
          const person = dir.getByRole('button', { name: '秦实', exact: true });
          await expect(person).toBeVisible();
          const avatar = (await person.locator('.account-avatar').boundingBox())!;
          assert.equal(avatar.height, 36);
          assert.equal(avatar.width, 36);
          assert.equal(Math.round((await rows.first().boundingBox())!.height), 56);
          await person.click();
          const profileCard = page.getByRole('dialog', { name: '秦实', exact: true });
          await expect(profileCard.locator('.member-card')).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(profileCard).toHaveCount(0);
          await dir.getByRole('button', { name: '秦实的操作' }).press('Enter');
          const menu = page.locator('.directory-menu:popover-open');
          await expect(menu).toBeVisible();
          const menuBounds = (await menu.boundingBox())!;
          assert(
            menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= page.viewportSize()!.width,
          );
          await expect(menu.getByRole('button').last()).toHaveText('删除账号');
          await menu.getByRole('button', { name: '删除账号' }).click();
          const retirementConfirm = page.getByRole('dialog', { name: '删除账号 · 秦实' });
          await expect(retirementConfirm).toBeVisible();
          await retirementConfirm.screenshot({ path: join(browserAssets, '05-删除账号确认.png') });
          await retirementConfirm.getByRole('button', { name: '取消' }).click();
          await dir.getByRole('button', { name: '秦实的操作' }).click();
          await menu.getByRole('button', { name: '编辑名片' }).click();
          const cardEditor = page.getByRole('dialog', { name: '编辑名片 · 秦实' });
          await expect(cardEditor).toBeVisible();
          await cardEditor.getByRole('button', { name: '关闭浮窗' }).click();
          await expect(cardEditor).toHaveCount(0);
          await dir.getByRole('button', { name: '部门管理' }).click();
          const departments = page.getByRole('dialog', { name: '部门管理' });
          await expect(departments).toBeVisible();
          await departments.getByRole('button', { name: '关闭浮窗' }).click();
          await expect(departments).toHaveCount(0);

          await secondary.getByRole('tab', { name: '业主账号' }).click();
          await expect(rows).toHaveCount(10);
          await expect(pagination).toContainText('共 14 条');
          await expect(dir.getByRole('button', { name: '部门管理' })).toHaveCount(0);
          await dir.getByRole('button', { name: '下一页' }).click();
          await expect(rows).toHaveCount(4);
          await expect(pagination).toContainText('2 / 2');
          await dir.getByRole('combobox', { name: '按工地筛选' }).selectOption('p2');
          await expect(pagination).toContainText('共 1 条');
          await expect(pagination).toContainText('1 / 1');
          await expect(rows).toHaveCount(1);
          await expect(rows.first()).toContainText('甲');
          await unchanged();
          await dir.getByRole('combobox', { name: '按工地筛选' }).selectOption('');
          await expect(rows).toHaveCount(10);
          const toolbar = await Promise.all([
            search.boundingBox(),
            dir.getByRole('combobox', { name: '按工地筛选' }).boundingBox(),
            dir.getByRole('button', { name: '新增授权' }).boundingBox(),
          ]);
          const centers = toolbar.map((box) => box!.y + box!.height / 2);
          assert.ok(Math.max(...centers) - Math.min(...centers) < 2);
          await screenshot('03-业主列表.png');
          await dir.getByRole('button', { name: '新增授权' }).click();
          const grant = page.getByRole('dialog', { name: '新增业主授权' });
          await expect(grant.getByLabel('工地')).toBeVisible();
          await grant.getByRole('button', { name: '关闭浮窗' }).click();
          await expect(grant).toHaveCount(0);

          for (const [name, file] of [['个人中心', '04-个人中心.png']]) {
            await primary.getByRole('tab', { name, exact: true }).click();
            await expect(primary.getByRole('tab', { name, exact: true })).toHaveAttribute(
              'aria-selected',
              'true',
            );
            await unchanged();
            await screenshot(file);
          }
          await primary.getByRole('tab', { name: '账号管理', exact: true }).click();
          await expect(secondary.getByRole('tab', { name: '业主账号' })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await secondary.getByRole('tab', { name: '员工账号' }).click();
          await unchanged();
          await shell.getByRole('button', { name: '关闭', exact: true }).click();
          await expect(shell).toHaveCount(0);
          await page.getByRole('button', { name: '编辑项目一号住宅' }).click();
          const projectDialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
          const rendering = projectDialog.getByLabel('效果图链接', { exact: true });
          await rendering.fill('https://vr.shinewonder.com/isolated-sample');
          await page.mouse.click(4, 4);
          await expect(projectDialog).toBeVisible();
          await projectDialog.getByRole('button', { name: '取消', exact: true }).click();
          const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' });
          await expect(discard).toBeVisible();
          await discard.getByRole('button', { name: '取消' }).click();
          await expect(rendering).toHaveValue('https://vr.shinewonder.com/isolated-sample');
          await expect(projectDialog.getByRole('link', { name: '预览效果图' })).toHaveAttribute(
            'rel',
            'noopener noreferrer',
          );
          await projectDialog.locator('.modal-body').evaluate((body) => {
            body.scrollTop = 0;
          });
          await projectDialog.screenshot({ path: join(browserAssets, '08-编辑项目.png') });
          await projectDialog.getByLabel('项目备注').fill('PROJECT-LINK-ATOMIC');
          const save = projectDialog.getByRole('button', { name: '保存', exact: true });
          await page.route(
            '**/api/projects/p1/owner-design',
            async (route) => {
              const committed = await route.fetch();
              assert.equal(committed.status(), 200);
              await route.fulfill({ status: 503, json: { error: '隔离测试模拟网络异常' } });
            },
            { times: 1 },
          );
          await save.click();
          await expect(projectDialog.getByRole('alert')).toContainText('隔离测试模拟网络异常');
          await expect(rendering).toHaveValue('https://vr.shinewonder.com/isolated-sample');
          await save.click();
          await expect(projectDialog).toHaveCount(0);
          assert.equal(
            (await request('/projects/p1/owner-design', 'GET', undefined, founder)).body.rendering,
            'https://vr.shinewonder.com/isolated-sample',
          );
          assert.equal(
            (await request('/workspace', 'GET', undefined, founder)).body.data.projects.find(
              (project: { id: string }) => project.id === 'p1',
            ).notes,
            'PROJECT-LINK-ATOMIC',
          );
          await page.getByRole('button', { name: '编辑当前项目' }).click();
          await rendering.waitFor();
          await projectDialog.getByRole('button', { name: '清空效果图' }).click();
          await save.click();
          await expect(projectDialog).toHaveCount(0);
          await page.close();

          const narrow = await open(founder, 720, 650, 'reduce', true);
          const compact = panel(narrow);
          const compactFrame = await compact.frame();
          assert.ok(Math.abs(compactFrame.shell[2] - 720 * 0.94) < 1);
          assert.equal(compactFrame.shell[3], 585);
          assert.equal(compactFrame.animation, 'none');
          for (const name of ['个人中心', '账号管理']) {
            await compact.primary.getByRole('tab', { name, exact: true }).click();
            await expect.poll(compact.frame).toEqual(compactFrame);
          }
          await compact.secondary.getByRole('tab', { name: '业主账号' }).click();
          await expect.poll(compact.frame).toEqual(compactFrame);
          const compactScroll = compact.dir.getByLabel('账号列表滚动区');
          await compactScroll.evaluate((node) => {
            node.scrollLeft = node.scrollWidth;
            node.scrollTop = node.scrollHeight;
          });
          await expect
            .poll(() => compactScroll.evaluate((node) => node.scrollLeft))
            .toBeGreaterThan(0);
          await expect
            .poll(() => compactScroll.evaluate((node) => node.scrollTop))
            .toBeGreaterThan(0);
          await expect(compact.dir.getByRole('columnheader', { name: '操作' })).toBeInViewport();
          assert.equal(
            await compact.shell.evaluate((node) => node.scrollWidth),
            await compact.shell.evaluate((node) => node.clientWidth),
          );
          await compactScroll.evaluate((node) => {
            node.scrollLeft = 0;
            node.scrollTop = 0;
          });
          await compact.shell.screenshot({ path: join(browserAssets, '07-窄屏账号管理.png') });
          await expect.poll(compact.frame).toEqual(compactFrame);
          await compact.shell.getByRole('button', { name: '关闭', exact: true }).click();
          await narrow.locator('.mobile-project-toggle').click();
          await narrow.getByTitle('一号住宅 · 项目设置').click();
          const narrowProject = narrow.getByRole('dialog', { name: '编辑项目', exact: true });
          await expect(
            narrowProject.getByRole('button', { name: '保存', exact: true }),
          ).toBeEnabled();
          const projectBody = narrowProject.locator('.modal-body');
          const projectFooter = narrowProject.locator('.modal-foot');
          await narrowProject.evaluate(async (modal) => {
            await Promise.all(
              modal.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
          const footerPosition = () =>
            projectFooter.evaluate((footer) => (footer as HTMLElement).offsetTop);
          const startFooter = await footerPosition();
          await projectBody.evaluate((body) => {
            body.scrollTop = body.scrollHeight;
          });
          await expect
            .poll(() => projectBody.evaluate((body) => body.scrollTop))
            .toBeGreaterThan(0);
          assert.equal(await footerPosition(), startFooter);
          const bodyBox = (await projectBody.boundingBox())!;
          assert.ok(bodyBox.y + bodyBox.height <= (await projectFooter.boundingBox())!.y + 1);
          await expect(narrowProject.getByLabel('水电图链接')).toBeInViewport();
          await narrowProject.screenshot({ path: join(browserAssets, '09-窄屏编辑项目.png') });
          await narrow.close();

          const staffBrowser = await open(staffResult.cookie, 720, 850, 'reduce');
          const ordinary = panel(staffBrowser);
          await expect(ordinary.secondary.getByRole('tab', { name: '业主账号' })).toHaveCount(0);
          await expect(ordinary.primary.getByRole('tab', { name: '备份导入' })).toHaveCount(0);
          await expect(ordinary.dir.getByRole('button', { name: '部门管理' })).toHaveCount(0);
          await ordinary.primary.getByRole('tab', { name: '个人中心' }).click();
          await expect(ordinary.shell.getByText('•••••••0027')).toBeVisible();
          await expect(ordinary.shell.getByText('已绑定', { exact: true })).toBeVisible();
          await expect(ordinary.shell.getByRole('button', { name: '退出登录' })).toBeVisible();
          await staffBrowser.close();
        } finally {
          await browser.close();
        }
      }

      assert.equal((await request(target, 'PUT', { action: 'unlink' }, founder)).status, 200);
      assert.equal(
        (await request('/auth/session', 'GET', undefined, staffResult.cookie)).status,
        401,
      );
      assert.deepEqual(await which('demo_a'), ['owner']);
      assert.equal(
        (await request(projects, 'GET', undefined, '', ownerResult.body.token)).status,
        200,
      );
      const linkedAgain = await call('bind-employee', attrs);
      assert.equal(linkedAgain.status, 200);
      await admin.query(
        "UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE account_id='unified-user'",
      );
      assert.equal(
        (await request('/auth/session', 'GET', undefined, linkedAgain.cookie)).status,
        401,
      );
      const again = await call('enter', { role: 'employee', code: 'demo_a' });
      assert.equal(again.status, 200);
      assert.equal(
        (
          await request(
            '/accounts/unified-user',
            'PATCH',
            { active: false, reason: 'departure' },
            founder,
          )
        ).status,
        200,
      );
      assert.equal((await request('/auth/session', 'GET', undefined, again.cookie)).status, 401);
      assert.deepEqual(await which('demo_a'), ['owner']);
      assert.equal(
        (await request('/accounts/unified-user', 'PATCH', { active: true }, founder)).status,
        200,
      );
      assert.equal((await call('enter', { role: 'employee', code: 'demo_a' })).status, 403);
    },
  );
  await t.test(
    'design links use the residence grant, a fixed HTTPS origin, and versioned audited writes',
    async () => {
      const settings = (id: string) => '/projects/' + id + '/owner-design';
      const feedDesign = (id: string, token: string) =>
        request('/mini-owner/v1/projects/' + id + '/design', 'GET', undefined, '', token);
      const startingAudits = (
        await admin.query("SELECT 1 FROM audit_event WHERE action='owner.design.update'")
      ).rowCount!;
      const body = {
        rendering: 'https://design.example.com/render/one',
        panorama: 'https://design.example.com/360/one',
        version: (await request(settings('p1'), 'GET', undefined, founder)).body.version as number,
      };
      assert.equal((await request(settings('p1'), 'GET', undefined, employee)).status, 403);
      assert.equal((await request(settings('p1'), 'PUT', body, employee)).status, 403);
      assert.equal((await request(settings('secret'), 'GET', undefined, founder)).status, 404);
      assert.equal((await feedDesign('p1', '')).status, 401);
      assert.deepEqual((await feedDesign('p1', tokenA)).body, { rendering: '', panorama: '' });
      for (const rendering of [
        'http://design.example.com/one',
        'https://design.example.com@external.example.com/one',
      ]) {
        assert.equal(
          (await request(settings('p1'), 'PUT', { ...body, rendering }, founder)).status,
          400,
        );
      }
      const stored = await request(settings('p1'), 'PUT', body, founder);
      assert.equal(stored.status, 200);
      assert.equal(stored.body.version, body.version + 1);
      assert.deepEqual((await feedDesign('p1', tokenA)).body, {
        rendering: body.rendering,
        panorama: body.panorama,
      });
      assert.deepEqual((await feedDesign('p1', tokenB)).body, {
        rendering: body.rendering,
        panorama: body.panorama,
      });
      assert.deepEqual((await feedDesign('p2', tokenA)).body, { rendering: '', panorama: '' });
      assert.equal((await feedDesign('p2', tokenB)).status, 404);
      assert.equal((await feedDesign('secret', tokenA)).status, 404);
      assert.equal((await request(settings('p1'), 'PUT', body, founder)).status, 409);
      assert.equal(
        (
          await request(
            settings('p1'),
            'PUT',
            { rendering: '', panorama: body.panorama, version: stored.body.version },
            founder,
          )
        ).status,
        200,
      );
      assert.deepEqual((await feedDesign('p1', tokenB)).body, {
        rendering: '',
        panorama: body.panorama,
      });
      const shinewonderLink = 'https://vr.shinewonder.com/pano/page/publik/pklimit?inf=sample@@demo&sig=a%2Fb#scene';
      const outside = await request(
        settings('p1'),
        'PUT',
        {
          rendering: shinewonderLink,
          panorama: '',
          version: stored.body.version + 1,
        },
        founder,
      );
      assert.equal(outside.status, 200);
      assert.deepEqual((await feedDesign('p1', tokenA)).body, {
        rendering: '',
        panorama: '',
        renderingUnavailable: true,
        renderingIssue: 'domain_unconfigured',
      });
      process.env.CHUNMO_OWNER_DESIGN_ORIGINS = 'vr.shinewonder.com,https://design.example.com';
      try {
        assert.deepEqual((await feedDesign('p1', tokenA)).body, {
          rendering: shinewonderLink,
          panorama: '',
        });
        assert.equal((await feedDesign('secret', tokenA)).status, 404);
      } finally {
        process.env.CHUNMO_OWNER_DESIGN_ORIGINS = 'https://design.example.com';
      }
      const auditRows = (
        await admin.query(
          "SELECT after_value,changed_fields FROM audit_event WHERE action='owner.design.update'",
        )
      ).rows;
      assert.equal(auditRows.length, startingAudits + 3);
      assert.ok(!JSON.stringify(auditRows).includes('https://'));
    },
  );
  const list = (await request(staffApi(), 'GET', undefined, founder)).body.members;
  assert.equal(list.find((row: { name: string }) => row.name === '甲').maskedPhone, '*******0001');
  assert.ok(!JSON.stringify(list).includes('13900000001'));
  const id = list.find((row: { name: string }) => row.name === '甲').id;
  assert.equal((await request(staffApi() + '/members/' + id, 'DELETE', {}, founder)).status, 200);
  assert.ok(evidencePhotoPath);
  assert.equal(
    (await request('/mini-owner/v1/projects/p1/design', 'GET', undefined, '', tokenA)).status,
    404,
  );
  assert.equal(
    (await request('/mini-owner/v1/projects/p2/design', 'GET', undefined, '', tokenA)).status,
    200,
  );
  assert.equal((await request(evidencePhotoPath, 'GET', undefined, '', tokenA)).status, 404);
  assert.equal((await request(evidencePhotoPath, 'GET', undefined, '', tokenB)).status, 200);
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
  await t.test(
    'employee avatar shares both authenticated surfaces; logical deletions revoke access and retain history',
    async () => {
      const localImage = async (width: number, background: string) =>
        'data:image/jpeg;base64,' +
        (
          await sharp({ create: { width, height: width, channels: 3, background } })
            .jpeg()
            .toBuffer()
        ).toString('base64');
      const miniHeaders = {
        Cookie: 'chunmo_session=' + employee,
        Referer: 'https://servicewechat.com/wx1111111111111111/0/page-frame.html',
      };
      const miniAvatar = base + '/api/mini-employee/v1/avatar';
      const miniRead = () => fetch(miniAvatar, { headers: miniHeaders });
      assert.equal((await miniRead()).status, 404);
      assert.equal(
        (
          await request(
            '/auth/avatar',
            'PUT',
            { image: await localImage(800, '#335b49') },
            employee,
          )
        ).status,
        200,
      );
      const saved = await miniRead();
      assert.equal(saved.status, 200);
      const savedBytes = await saved.arrayBuffer();
      assert.match(saved.headers.get('cache-control') ?? '', /no-store/);
      const upload = (csrf: string) =>
        localImage(512, '#2e403b').then((image) =>
          fetch(miniAvatar, {
            method: 'PUT',
            headers: { ...miniHeaders, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify({ image }),
          }),
        );
      assert.equal((await upload('')).status, 403);
      assert.equal((await upload(hash('csrf:' + employee))).status, 200);
      const web = await fetch(base + '/api/accounts/employee/avatar', {
        headers: { Cookie: miniHeaders.Cookie },
      });
      assert.equal(web.status, 200);
      const webBytes = await web.arrayBuffer();
      assert.notDeepEqual(webBytes, savedBytes);
      assert.deepEqual(await (await miniRead()).arrayBuffer(), webBytes);
      assert.equal((await request('/accounts/employee', 'DELETE', {}, employee)).status, 403);
      assert.equal((await request('/accounts/founder', 'DELETE', {}, founder)).status, 409);
      assert.equal((await request('/accounts/employee', 'DELETE', {}, founder)).status, 200);
      assert.equal((await miniRead()).status, 401);
      assert.equal(
        (await request('/accounts/employee', 'PATCH', { active: true }, founder)).status,
        404,
      );
      assert.equal(
        (await request('/directory', 'GET', undefined, founder)).body.accounts.some(
          (account: { id: string }) => account.id === 'employee',
        ),
        false,
      );
      assert.equal(
        (await admin.query("SELECT active FROM account WHERE id='employee'")).rows[0].active,
        false,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT id FROM audit_event WHERE action='account.delete' AND entity_id='employee'",
          )
        ).rowCount,
        1,
      );

      await admin.query('DELETE FROM owner_portal.login_limit');
      verified = { openid: 'retirement', phone: '13900000112' };
      const authorization = async () =>
        request(
          staffApi() + '/members',
          'POST',
          { name: '隔离账号', phone: verified.phone, create: true },
          founder,
        );
      const original = await authorization();
      const signed = await login(original.body.invite);
      assert.equal(signed.status, 200);
      const id = signed.body.owner.id;
      assert.equal(
        (await request('/owner-accounts/' + id + '/unlink', 'POST', {}, founder)).status,
        200,
      );
      assert.equal((await request(projects, 'GET', undefined, '', signed.body.token)).status, 401);
      const stillAuthorized = (
        await request(staffApi(), 'GET', undefined, founder)
      ).body.members.find((member: { id: string }) => member.id === id);
      assert.equal(stillAuthorized.active, true);
      assert.equal(stillAuthorized.bound, false);
      const invitedAgain = await request(
        staffApi() + '/members/' + id + '/invite',
        'POST',
        {},
        founder,
      );
      const signedAgain = await login(invitedAgain.body.invite);
      assert.equal(signedAgain.status, 200);
      assert.equal((await request('/owner-accounts/' + id, 'DELETE', {}, founder)).status, 200);
      assert.equal(
        (await request(projects, 'GET', undefined, '', signedAgain.body.token)).status,
        401,
      );
      assert.equal(
        (await request('/owner-accounts', 'GET', undefined, founder)).body.members.some(
          (member: { id: string }) => member.id === id,
        ),
        false,
      );
      assert.equal(
        (await request(staffApi() + '/members', 'POST', { memberId: id }, founder)).status,
        404,
      );
      assert.equal(
        (
          await admin.query(
            'SELECT revoked_at FROM owner_portal.project_grant WHERE member_id=$1 AND revoked_at IS NOT NULL',
            [id],
          )
        ).rowCount,
        1,
      );
      const replacement = await authorization();
      assert.equal(replacement.status, 200);
      const again = await login(replacement.body.invite);
      assert.equal(again.status, 200);
      assert.notEqual(again.body.owner.id, id);
    },
  );
});
