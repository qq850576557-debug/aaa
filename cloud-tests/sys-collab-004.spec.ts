import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { prepareWorkspace, today, plus, removeProject, type Data } from '../src/lib/model';
import { readFile } from 'node:fs/promises';

test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function enter(page: Page, login: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const response = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET'
            ? {}
            : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    },
    { path, method, body },
  );
}
async function seed(page: Page, clients = 2) {
  const f = await fixtureAccounts(clients - 1);
  await enter(page, f.login, f.password);
  const d = prepareWorkspace(fixture());
  d.people = [];
  d.dictionaries = [];
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  return { f, d };
}
async function addPerson(page: Page, name: string, role = '施工人员', skills: string[] = []) {
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.getByRole('button', { name: '新增人员', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增人员档案', exact: true });
  await form.getByLabel('姓名', { exact: true }).fill(name);
  await form.getByLabel('工作职责', { exact: true }).selectOption(role);
  for (const skill of skills) await form.getByLabel('人员工种' + skill, { exact: true }).check();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  return form;
}

test('SYS-COLLAB-004 baseline: actual personnel creation, multiple worker types and immediate editing persist valid unique IDs', async ({
  page,
}) => {
  const { f, d } = await seed(page);
  await addPerson(page, '普通施工师傅');
  await expect(page.locator('.save-state')).toContainText('已保存');
  await addPerson(page, '项目管理人员', '项目经理');
  await expect(page.locator('.save-state')).toContainText('已保存');
  await addPerson(page, '多技能师傅', '施工人员', ['木工', '水电工']);
  await expect(page.locator('.save-state')).toContainText('已保存');
  let data: Data = (await api(page)).value.data;
  expect(data.people).toHaveLength(3);
  expect(new Set(data.people!.map((p) => p.id)).size).toBe(3);
  expect(data.people![2].tradeIds).toHaveLength(2);
  for (const key of data.people![2].tradeIds!)
    expect(data.dictionaries!.some((x) => x.id === key)).toBe(true);
  await page.getByRole('button', { name: '打开人员档案：多技能师傅', exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑人员档案', exact: true });
  await form.getByLabel('姓名', { exact: true }).fill('多技能师傅已编辑');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  data = (await api(page)).value.data;
  expect(data.people![2].name).toBe('多技能师傅已编辑');
  expect(data.tasks).toEqual(d.tasks);
  const personId = data.people![2].id;
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  const card = page.locator(`[data-person-id="${personId}"]`);
  await card.locator('.staff-projects > summary').click();
  await card.getByRole('button', { name: '管理项目分配', exact: true }).click();
  const assign = page.getByRole('dialog', { name: '分配人员 · 多技能师傅已编辑', exact: true });
  await assign.getByLabel('分配位置', { exact: true }).selectOption(`trade:${d.trades[1].id}`);
  await assign.getByRole('button', { name: '确认分配', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '上移人员多技能师傅已编辑', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page.getByRole('button', { name: `在${d.projects[0].name}新增记录`, exact: true }).click();
  const drawer = page.locator('.record-drawer');
  await drawer.getByLabel('任务事项', { exact: true }).fill('新增人员后的现场跟进');
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '打开记录：新增人员后的现场跟进', exact: true }),
  ).toBeVisible();
  for (const name of [
    '项目工作空间',
    '采购管理',
    '提醒中心',
    '已完工项目',
    '人员管理',
    '材料资产管理',
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }
  data = (await api(page)).value.data;
  expect(data.trades[1].staffIds).toContain(personId);
  expect(data.people![1].id).toBe(personId);
  expect(
    (
      await fixtureQuery('SELECT count(*)::int n FROM person WHERE workspace_id=$1', [
        (await api(page, '/auth/session')).value.user.workspaceId,
      ])
    ).rows[0].n,
  ).toBe(3);
  await api(page, '/auth/logout', 'POST', {});
  await enter(page, f.login, f.password);
  expect((await api(page)).value.data).toEqual(data);
});

test('SYS-COLLAB-004: rejected deletion can be explicitly reconciled with cloud without clearing its original recovery snapshot or unrelated saved purchases', async ({
  page,
}) => {
  const { f, d } = await seed(page);
  let rejected = false;
  await page.route('**/api/workspace', async (route) => {
    if (
      route.request().method() === 'PUT' &&
      !route
        .request()
        .postDataJSON()
        .data.trades.some((x: { id: string }) => x.id === d.trades[0].id)
    ) {
      rejected = true;
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: '数据校验失败；未覆盖已保存数据' }),
      });
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑现场拆改', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑工种', exact: true });
  await editor.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(() => rejected).toBe(true);
  await expect(page.locator('.error-banner')).toContainText('数据校验失败');
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page
    .locator('.purchase-list')
    .getByRole('button', { name: /^完成采购/ })
    .first()
    .click();
  await expect.poll(async () => (await api(page)).value.data.purchases[0].status).toBe('已完成');
  await page.getByRole('button', { name: '重新读取云端', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '核对未保存记录', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('radio', { name: '采用云端内容', exact: true })).toHaveCount(2);
  for (const choice of await panel.getByRole('radio', { name: '采用云端内容', exact: true }).all())
    await choice.check();
  await panel.getByRole('button', { name: '确认选择并保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const final = (await api(page)).value.data;
  expect(final.trades).toEqual(d.trades);
  expect(final.tasks).toEqual(d.tasks);
  expect(final.purchases[0].status).toBe('已完成');
  const kept = await page.evaluate(
    async ({ f }) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('chunmo-cloud-drafts', 1);
        r.onsuccess = () => resolve(r.result);
      });
      const values = await new Promise<any[]>((resolve) => {
        const q = db.transaction('drafts').objectStore('drafts').getAll();
        q.onsuccess = () => resolve(q.result);
      });
      db.close();
      return values.filter((x) => x.accountId === f.id && x.workspaceId === f.workspaceId);
    },
    { f },
  );
  expect(
    kept.some((x) => !x.data.trades.some((g: { id: string }) => g.id === d.trades[0].id)),
  ).toBe(true);
});

test('SYS-COLLAB-004: one rejected personnel save must not lock unrelated procurement, and correction retains the full draft', async ({
  page,
}) => {
  await seed(page);
  let rejected = false;
  await page.route('**/api/workspace', async (route) => {
    const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : null;
    if (body?.data.people.some((p: { name: string }) => p.name === '需要修正的师傅')) {
      rejected = true;
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: '数据校验失败；未覆盖已保存数据',
          issues: [
            {
              path: ['data', 'people', 0, 'name'],
              code: 'custom',
              message: '测试：该人员资料需核对',
            },
          ],
        }),
      });
    }
    await route.continue();
  });
  await addPerson(page, '需要修正的师傅');
  await expect.poll(() => rejected).toBe(true);
  await expect(page.locator('.error-banner')).toContainText('数据校验失败');
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page
    .locator('.purchase-list')
    .getByRole('button', { name: /^完成采购/ })
    .first()
    .click();
  await expect.poll(async () => (await api(page)).value.data.purchases[0].status).toBe('已完成');
  expect((await api(page)).value.data.people).toHaveLength(0);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.getByRole('button', { name: '打开人员档案：需要修正的师傅', exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑人员档案', exact: true });
  await form.getByLabel('姓名', { exact: true }).fill('资料已修正的师傅');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const saved = (await api(page)).value.data;
  expect(saved.people.map((p: { name: string }) => p.name)).toEqual(['资料已修正的师傅']);
  expect(saved.purchases[0].status).toBe('已完成');
});

test('SYS-COLLAB-004: a disconnected personnel request automatically resumes with the same receipt when connectivity returns', async ({
  page,
}) => {
  await seed(page);
  let disconnected = true;
  const receipts: string[] = [];
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT') {
      receipts.push(route.request().postDataJSON().requestId);
      if (disconnected) return route.abort('internetdisconnected');
    }
    await route.continue();
  });
  await addPerson(page, '断网期间新增的师傅', '施工人员', ['瓦工']);
  await expect(page.locator('.error-banner')).toContainText('未丢弃草稿');
  disconnected = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.save-state')).toContainText('已保存', { timeout: 15000 });
  const saved = (await api(page)).value;
  expect(saved.data.people.map((p: { name: string }) => p.name)).toEqual(['断网期间新增的师傅']);
  expect(receipts.length).toBeGreaterThan(1);
  expect(new Set(receipts).size).toBe(1);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
});

test('SYS-COLLAB-004: ten independent browser accounts concurrently add people and edit schedules, purchases, notes and projects without missing records', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const contexts = await Promise.all(Array.from({ length: 10 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  let release = () => {};
  try {
    const { f, d } = await seed(pages[0], 10);
    // Provision only via the guarded local fixture. Production account creation
    // retains its five-per-minute password-operation protection unchanged.
    const logins = [f.login, ...f.employees.map((x) => x.login)];
    for (let i = 1; i < 10; i++) await enter(pages[i], logins[i], f.password);
    let gate = new Promise<void>((r) => {
      release = r;
    });
    let arrivals = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      pages[i].on('response', (r) => {
        if (r.url().endsWith('/api/workspace') && r.request().method() === 'PUT')
          statuses.push(r.status());
      });
      await contexts[i].route('**/api/workspace', async (route) => {
        if (route.request().method() === 'PUT') {
          arrivals++;
          await gate;
        }
        await route.continue();
      });
    }
    await Promise.all(
      pages.map((page, i) => addPerson(page, `并发施工师傅${i}`, '施工人员', ['木工', '水电工'])),
    );
    await expect.poll(() => arrivals, { timeout: 30000 }).toBe(10);
    release();
    await Promise.all(
      pages.map((p) =>
        expect(p.locator('.save-state')).toContainText('已保存', { timeout: 30000 }),
      ),
    );
    const initial: Data = (await api(pages[0])).value.data;
    expect(initial.people).toHaveLength(10);
    expect(new Set(initial.people!.map((x) => x.id)).size).toBe(10);
    expect(initial.dictionaries).toHaveLength(2);
    for (const person of initial.people!) expect(person.tradeIds).toHaveLength(2);
    gate = new Promise<void>((r) => {
      release = r;
    });
    const sources = await Promise.all(pages.map((p) => api(p)));
    const changes = [
      (x: Data) => {
        x.tasks[0].start = plus(x.tasks[0].start, 1);
        x.tasks[0].end = plus(x.tasks[0].end, 1);
      },
      (x: Data) => {
        x.purchases[0].status = '已完成';
      },
      (x: Data) => {
        x.notes[0].content = '其他客户端同步修改事项';
      },
      (x: Data) => {
        x.projects[0].notes = '其他客户端同步修改项目';
      },
      (x: Data) => {
        x.trades[0].color = '#c05872';
      },
      (x: Data) => {
        x.notes.push({
          ...x.notes[0],
          id: 'tomorrow-004',
          title: '明日施工安排',
          kind: '施工安排',
          date: plus(today(), 1),
          reminder: plus(today(), 1),
        });
      },
    ];
    const requests = changes.map((change, i) => {
      const source = sources[i + 4].value;
      const data = structuredClone(source.data);
      change(data);
      return api(pages[i + 4], '/workspace', 'PUT', {
        revision: source.revision,
        base: source.data,
        baseProof: source.baseProof,
        requestId: crypto.randomUUID(),
        data,
      });
    });
    await Promise.all(
      pages.slice(0, 4).map((page, i) => addPerson(page, `混合业务期间新增${i}`, '项目经理')),
    );
    await expect.poll(() => arrivals, { timeout: 30000 }).toBe(20);
    release();
    expect((await Promise.all(requests)).map((x) => x.status)).toEqual(Array(6).fill(200));
    await Promise.all(
      pages
        .slice(0, 4)
        .map((p) => expect(p.locator('.save-state')).toContainText('已保存', { timeout: 30000 })),
    );
    await expect.poll(() => statuses.length).toBe(20);
    expect(statuses).toEqual(Array(20).fill(200));
    const final: Data = (await api(pages[0])).value.data;
    expect(final.people).toHaveLength(14);
    expect(final.nameHistory).toEqual(expect.arrayContaining(final.people!.map((x) => x.name)));
    expect(new Set(final.people!.map((x) => x.id)).size).toBe(14);
    expect(final.tasks[0].start).toBe(plus(d.tasks[0].start, 1));
    expect(final.tasks[1]).toEqual(d.tasks[1]);
    expect(final.purchases[0].status).toBe('已完成');
    expect(final.notes[0].content).toBe('其他客户端同步修改事项');
    expect(final.projects[0].notes).toBe('其他客户端同步修改项目');
    expect(final.trades[0].color).toBe('#c05872');
    expect(final.notes.filter((x) => x.id === 'tomorrow-004')).toHaveLength(1);
    const reads = await Promise.all(pages.map((p) => api(p)));
    for (const read of reads) expect(read.value.data).toEqual(final);
    expect(
      (
        await fixtureQuery('SELECT count(*)::int n FROM person WHERE workspace_id=$1', [
          f.workspaceId,
        ])
      ).rows[0].n,
    ).toBe(14);
    const receipts = await fixtureQuery(
      "SELECT count(*)::int n FROM audit_event WHERE workspace_id=$1 AND entity_type='workspace_submission'",
      [f.workspaceId],
    );
    expect(receipts.rows[0].n).toBe(20);
    for (const p of pages) await expect(p.locator('.error-banner')).toHaveCount(0);
    await pages[0].reload();
    await expect(pages[0].locator('.save-state')).toContainText('已保存');
    expect((await api(pages[0])).value.data).toEqual(final);
    await test.info().attach('ten-session-results', {
      body: JSON.stringify({
        clients: 10,
        barrieredWrites: arrivals,
        statusCodes: statuses,
        savedPeople: final.people!.length,
        uniquePeople: new Set(final.people!.map((x) => x.id)).size,
        receipts: receipts.rows[0].n,
      }),
      contentType: 'application/json',
    });
  } finally {
    release();
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('SYS-COLLAB-004: temporarily busy APIs retry automatically with one unchanged receipt instead of quarantining valid personnel', async ({
  page,
}) => {
  await seed(page);
  const receipts: string[] = [];
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT') {
      receipts.push(route.request().postDataJSON().requestId);
      if (receipts.length <= 2)
        return route.fulfill({
          status: receipts.length === 1 ? 429 : 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '服务暂时繁忙' }),
        });
    }
    await route.continue();
  });
  await addPerson(page, '繁忙期间新增的师傅');
  await expect(page.locator('.save-state')).toContainText('已保存', { timeout: 15000 });
  expect(receipts).toHaveLength(3);
  expect(new Set(receipts).size).toBe(1);
  expect((await api(page)).value.data.people.map((p: { name: string }) => p.name)).toEqual([
    '繁忙期间新增的师傅',
  ]);
});

test('SYS-COLLAB-004: a genuine same-person conflict does not block unrelated purchases; refresh preserves it and explicit resolution loses no edits', async ({
  browser,
}) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  let release = () => {};
  try {
    const { f } = await seed(a);
    await addPerson(a, '共同编辑的师傅');
    await expect(a.locator('.save-state')).toContainText('已保存');
    await enter(b, f.employee, f.password);
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let waiting = 0;
    for (const c of contexts)
      await c.route('**/api/workspace', async (route) => {
        if (route.request().method() === 'PUT') {
          waiting++;
          await gate;
        }
        await route.continue();
      });
    await Promise.all(
      [a, b].map(async (p, i) => {
        await p.getByRole('button', { name: '人员管理', exact: true }).click();
        await p.getByRole('button', { name: '打开人员档案：共同编辑的师傅', exact: true }).click();
        const form = p.getByRole('dialog', { name: '编辑人员档案', exact: true });
        await form.getByLabel('姓名', { exact: true }).fill(i ? '乙修改姓名' : '甲修改姓名');
        await form.getByRole('button', { name: '保存', exact: true }).click();
      }),
    );
    await expect.poll(() => waiting).toBe(2);
    release();
    await expect
      .poll(
        async () =>
          [
            await a.locator('.save-state').textContent(),
            await b.locator('.save-state').textContent(),
          ].filter((x) => x?.includes('保存冲突')).length,
      )
      .toBe(1);
    const cloud = (await api(a)).value.data.people[0].name;
    const loser = cloud === '甲修改姓名' ? b : a;
    let panel = loser.getByRole('dialog', { name: '核对保存冲突', exact: true });
    await panel.getByRole('button', { name: '稍后处理', exact: true }).click();
    await loser.getByRole('button', { name: '采购管理', exact: true }).click();
    await loser
      .locator('.purchase-list')
      .getByRole('button', { name: /^完成采购/ })
      .first()
      .click();
    await expect.poll(async () => (await api(loser)).value.data.purchases[0].status).toBe('已完成');
    expect((await api(loser)).value.data.people[0].name).toBe(cloud);
    loser.on('dialog', (d) => d.accept());
    await loser.reload();
    await expect(loser.locator('.save-state')).toContainText('草稿待恢复');
    await loser.getByRole('button', { name: '重试保存', exact: true }).click();
    panel = loser.getByRole('dialog', { name: '核对保存冲突', exact: true });
    await panel.getByRole('radio', { name: '采用云端内容' }).check();
    await panel.getByRole('button', { name: '确认选择并保存', exact: true }).click();
    await expect(loser.locator('.save-state')).toContainText('已保存');
    const final = (await api(loser)).value.data;
    expect(final.people[0].name).toBe(cloud);
    expect(final.purchases[0].status).toBe('已完成');
  } finally {
    release();
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('SYS-COLLAB-004: incompatible old draft is retained verbatim and downloadable without blocking fresh personnel saves or exposing another account', async ({
  page,
}) => {
  const { f } = await seed(page);
  const source = (await api(page)).value;
  const original = await page.evaluate(
    async ({ source, f }) => {
      const raw = {
        version: 1,
        accountId: f.id,
        workspaceId: f.workspaceId,
        tabId: sessionStorage.getItem('chunmo-cloud-draft-tab'),
        at: new Date().toISOString(),
        base: source,
        mergeBase: source.data,
        data: {
          ...source.data,
          people: [
            {
              id: 'old-invalid-person',
              name: '保留原草稿的师傅',
              role: '施工人员',
              trade: '',
              notes: '',
              active: true,
              obsoleteField: '旧字段原样保留',
            },
          ],
        },
        inFlight: null,
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('chunmo-cloud-drafts', 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put(raw, JSON.stringify([f.workspaceId, f.id, raw.tabId]));
        tx.objectStore('drafts').put(
          {
            ...raw,
            accountId: f.employeeId,
            data: { ...raw.data, nameHistory: ['其他账号的隔离标记'] },
          },
          JSON.stringify([f.workspaceId, f.employeeId, raw.tabId]),
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return raw;
    },
    { source, f },
  );
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await expect(page.getByText(/旧草稿结构需要核对/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载旧草稿恢复包', exact: true }).click();
  const pack = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(pack.entries).toHaveLength(2);
  for (const entry of pack.entries) expect(entry.draft).toEqual(original);
  expect(JSON.stringify(pack)).not.toContain('其他账号的隔离标记');
  await addPerson(page, '旧草稿隔离后新增人员');
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await api(page)).value.data.people.map((p: { name: string }) => p.name)).toEqual([
    '旧草稿隔离后新增人员',
  ]);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await expect(page.getByRole('button', { name: '下载旧草稿恢复包', exact: true })).toBeVisible();
});

test('SYS-COLLAB-004: a deleted-project conflict keeps its original draft while SSE and unrelated project editing remain usable', async ({
  browser,
}) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    const { f, d } = await seed(a);
    async function save(change: (data: Data) => void) {
      const source = (await api(a)).value;
      const data = structuredClone(source.data);
      change(data);
      const r = await api(a, '/workspace', 'PUT', {
        revision: source.revision,
        base: source.data,
        baseProof: source.baseProof,
        requestId: crypto.randomUUID(),
        data,
      });
      expect(r.status, JSON.stringify(r.value)).toBe(200);
    }
    const other = { ...d.projects[0], id: 'unrelated-site', name: '不受冲突影响的工地' };
    await save((data) => {
      data.projects.push(other);
    });
    await a.reload();
    await expect(a.locator('.save-state')).toContainText('已保存');
    await enter(b, f.employee, f.password);
    await b.getByRole('button', { name: '编辑现场拆改', exact: true }).click();
    const editor = b.getByRole('dialog', { name: '编辑工种', exact: true });
    await editor.getByLabel('工种名称', { exact: true }).fill('保留尚未提交的工序改名');
    await save((data) => {
      Object.assign(data, removeProject(data, d.projects[0].id));
      data.projects[0].notes = '删除后其他工地的云端内容';
    });
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    let panel = b.getByRole('dialog', { name: '核对保存冲突', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '稍后处理', exact: true }).click();
    await save((data) => {
      data.projects[0].notes = '冲突待处理期间继续收到的SSE更新';
    });
    await expect
      .poll(
        () =>
          b.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve) => {
              const r = indexedDB.open('chunmo-cloud-drafts', 1);
              r.onsuccess = () => resolve(r.result);
            });
            const drafts = await new Promise<any[]>((resolve) => {
              const r = db.transaction('drafts').objectStore('drafts').getAll();
              r.onsuccess = () => resolve(r.result);
            });
            db.close();
            return drafts
              .find((x) => x.tabId === sessionStorage.getItem('chunmo-cloud-draft-tab'))
              ?.data.projects.find((x: { id: string }) => x.id === 'unrelated-site')?.notes;
          }),
        { timeout: 15000 },
      )
      .toBe('冲突待处理期间继续收到的SSE更新');
    await b.getByRole('button', { name: '编辑项目不受冲突影响的工地', exact: true }).click();
    const project = b.getByRole('dialog', { name: '编辑项目', exact: true });
    await project.getByLabel('项目备注', { exact: true }).fill('冲突期间另一个项目仍能保存');
    await project.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(async () => (await api(a)).value.data.projects[0].notes)
      .toBe('冲突期间另一个项目仍能保存');
    const current = (await api(a)).value.data;
    expect(current.projects.map((x: { id: string }) => x.id)).toEqual(['unrelated-site']);
    expect(current.trades.some((x: { id: string }) => x.id === d.trades[0].id)).toBe(false);
    b.on('dialog', (dialog) => dialog.accept());
    await b.reload();
    await expect(b.locator('.save-state')).toContainText('草稿待恢复');
    await b.getByRole('button', { name: '重试保存', exact: true }).click();
    panel = b.getByRole('dialog', { name: '核对保存冲突', exact: true });
    await expect(panel).toBeVisible();
    for (const choice of await panel
      .getByRole('radio', { name: '采用云端内容', exact: true })
      .all())
      await choice.check();
    await panel.getByRole('button', { name: '确认选择并保存', exact: true }).click();
    await expect(b.locator('.save-state')).toContainText('已保存');
    expect((await api(b)).value.data).toEqual(current);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
