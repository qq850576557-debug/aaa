import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import test from 'node:test';
import pg from 'pg';
import { createApp } from './app';
import { config } from './config';
import { pool, privatePool } from './db';
import { hash } from './store';
import { migrate } from './migrate';
import { officialOwnerWechat } from './owner-wechat';
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
    'GRANT SELECT ON account,auth_session,cloud_workspace,account_avatar,card_avatar TO ' +
      staff.username,
  );
  const migration = await readFile('server/proposed/017_owner_purchase.sql', 'utf8');
  const grants = await readFile('server/proposed/017_owner_purchase_grants.sql', 'utf8');
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
    await migrationClient.query('COMMIT');
  } catch (error) {
    await migrationClient.query('ROLLBACK');
    throw error;
  } finally {
    migrationClient.release();
  }
  const migrationRows = await admin.query(
    'SELECT filename,sha256 FROM owner_portal.purchase_migration ORDER BY filename COLLATE "C"',
  );
  assert.deepEqual(migrationRows.rows, [
    { filename: '017_owner_purchase.sql', sha256: hash(migration) },
    { filename: '017_owner_purchase_grants.sql', sha256: hash(grants) },
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
  t.after(() => {
    delete process.env.CHUNMO_OWNER_PORTAL_ENABLED;
    delete process.env.CHUNMO_OWNER_PURCHASE_ENABLED;
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
  const artifacts = process.env.CHUNMO_OWNER_BROWSER_ARTIFACTS;
  if (artifacts) app.use(express.static('dist'));
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
  await t.test(
    'existing and new purchases publish safely and synchronize through completion',
    async () => {
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
        const { chromium } = await import('@playwright/test');
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
          await normal.close();
          const savedPending = (await request('/workspace', 'GET', undefined, founder)).body;
          const browserNames = new Set([pendingName, ...visibleNames, privateName]);
          assert.equal(savedPending.data.purchases.length, browserNames.size + 1);
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
    },
  );
  const list = (await request(staffApi(), 'GET', undefined, founder)).body.members;
  assert.equal(list.find((row: { name: string }) => row.name === '甲').maskedPhone, '*******0001');
  assert.ok(!JSON.stringify(list).includes('13900000001'));
  const id = list.find((row: { name: string }) => row.name === '甲').id;
  assert.equal((await request(staffApi() + '/members/' + id, 'DELETE', {}, founder)).status, 200);
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
