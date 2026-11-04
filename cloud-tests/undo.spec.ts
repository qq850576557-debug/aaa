import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { assessmentToday } from '../src/lib/assessments';
async function login(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
async function api(c: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await c.request.get('/api/auth/session')).json();
  return c.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
    ...(data ? { data } : {}),
  });
}
const undo = (p: Page) =>
  p.locator('.business-undo-controls').getByRole('button', { name: '撤销', exact: true });
const redo = (p: Page) => p.getByRole('button', { name: '重做', exact: true });
async function client(p: Page, path: string, method: string, body: any) {
  return p.evaluate(
    async ({ path, method, body }) => {
      const { cloudApi } = await import('/src/lib/cloud.ts' as string);
      return cloudApi(path, method, body);
    },
    { path, method, body },
  );
}
test('record creation, editing and soft deletion undo/redo keep ID and audit, reject peer changes and resume offline inverse once', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await fixtureAccounts(),
    c = await browser.newContext(),
    peer = await browser.newContext();
  try {
    const p = await c.newPage(),
      b = await peer.newPage();
    await login(p, f.login, f.password);
    await api(c, '/workspace', 'PUT', { revision: 0, data: fixture() });
    await p.reload();
    await login(b, f.employee, f.password);
    await p.getByRole('button', { name: '事项管理', exact: true }).click();
    await expect(p.locator('.record-board')).toBeVisible();
    const value = {
      projectId: 'p-home',
      title: '可撤销事项',
      nodeDate: assessmentToday(),
      status: '待执行',
      notes: '初始',
      followUp: '',
      owner: '',
    };
    const created: any = await client(p, '/records', 'POST', {
      requestId: crypto.randomUUID(),
      value,
    });
    await client(p, `/records/${created.id}`, 'PUT', {
      requestId: crypto.randomUUID(),
      version: created.version,
      value: { ...value, notes: '自己的修改' },
    });
    let current = await (await api(c, `/records/${created.id}/history`)).json();
    await client(p, `/records/${created.id}`, 'DELETE', {
      requestId: crypto.randomUUID(),
      version: current.record.version,
    });
    const deletedRecord = (await (await api(c, `/records/${created.id}/history`)).json()).record;
    expect(
      (
        await api(peer, `/records/${created.id}`, 'PUT', {
          requestId: crypto.randomUUID(),
          version: deletedRecord.version,
          restore: true,
          value,
        })
      ).status(),
    ).toBe(409);
    await undo(p).click();
    await expect
      .poll(
        async () => (await (await api(c, `/records/${created.id}/history`)).json()).record.deleted,
      )
      .toBe(false);
    await undo(p).click();
    await expect
      .poll(
        async () => (await (await api(c, `/records/${created.id}/history`)).json()).record.notes,
      )
      .toBe('初始');
    await undo(p).click();
    await expect
      .poll(
        async () => (await (await api(c, `/records/${created.id}/history`)).json()).record.deleted,
      )
      .toBe(true);
    for (let i = 0; i < 3; i++) {
      await redo(p).click();
      await expect.poll(() => redo(p).isEnabled()).toBe(i < 2);
    }
    await expect
      .poll(
        async () => (await (await api(c, `/records/${created.id}/history`)).json()).record.deleted,
      )
      .toBe(true);
    current = await (await api(c, `/records/${created.id}/history`)).json();
    expect(current.record.id).toBe(created.id);
    expect(current.record.createdAt).toBe(created.createdAt);
    expect(current.record.deleted).toBe(true);
    await undo(p).click();
    await expect
      .poll(
        async () => (await (await api(c, `/records/${created.id}/history`)).json()).record.deleted,
      )
      .toBe(false);
    current = await (await api(c, `/records/${created.id}/history`)).json();
    await api(peer, `/records/${created.id}`, 'PUT', {
      requestId: crypto.randomUUID(),
      version: current.record.version,
      value: { ...value, notes: '其他员工的新修改' },
    });
    await undo(p).click();
    await expect(p.locator('.undo-operation-message')).toContainText(/后续修改|其他人/);
    expect((await (await api(c, `/records/${created.id}/history`)).json()).record.notes).toBe(
      '其他员工的新修改',
    );
    await p.getByRole('button', { name: '保留当前并放弃此步', exact: true }).click();
    // A rejected inverse stays available for review; another record can still be edited offline.
    const offline: any = await client(p, '/records', 'POST', {
      requestId: crypto.randomUUID(),
      value: { ...value, title: '离线逆向事项', notes: '离线前' },
    });
    await client(p, `/records/${offline.id}`, 'PUT', {
      requestId: crypto.randomUUID(),
      version: offline.version,
      value: { ...value, title: '离线逆向事项', notes: '自己的新修改' },
    });
    await c.setOffline(true);
    await undo(p).click();
    await expect(p.locator('.sidebar-save-status .save-current-state')).toContainText(/同步|异常/);
    await c.setOffline(false);
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(
        async () => (await (await api(c, `/records/${offline.id}/history`)).json()).record.notes,
      )
      .toBe('离线前');
  } finally {
    await c.close();
    await peer.close();
  }
});
test('daily checks undo and redo share durable tri-state records and preserve server actor history', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await login(page, f.login, f.password);
  const d = fixture();
  d.people = [
    {
      id: 'undo-worker',
      name: '撤销师傅',
      role: '施工人员',
      trade: '木工',
      notes: '',
      active: true,
    },
  ];
  await api(page.context(), '/workspace', 'PUT', { revision: 0, data: d });
  await page.reload();
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.locator('.assessment-choose-person').first().click();
  await page.getByRole('listbox').locator('[data-person-id="undo-worker"]').click();
  const row = page.locator('.assessment-day-row[data-person-id="undo-worker"]');
  await row.getByRole('combobox', { name: '撤销师傅签到', exact: true }).selectOption('yes');
  await expect(row.getByRole('combobox', { name: '撤销师傅签到', exact: true })).toHaveValue('yes');
  await undo(page).click();
  await expect(row.getByRole('combobox', { name: '撤销师傅签到', exact: true })).toHaveValue(
    'pending',
  );
  await redo(page).click();
  await expect(row.getByRole('combobox', { name: '撤销师傅签到', exact: true })).toHaveValue('yes');
  await expect
    .poll(
      async () =>
        (
          await (
            await api(
              page.context(),
              `/assessments?from=${assessmentToday()}&to=${assessmentToday()}`,
            )
          ).json()
        ).records[0]?.attendance,
    )
    .toBe('yes');
});

test('workspace inverse changes only owned resources, procurement status reverses and a peer project edit is retained', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    c = await browser.newContext(),
    peer = await browser.newContext();
  try {
    const p = await c.newPage(),
      b = await peer.newPage();
    await login(p, f.login, f.password);
    const d = fixture();
    await api(c, '/workspace', 'PUT', { revision: 0, data: d });
    await p.reload();
    await login(b, f.employee, f.password);
    await p.getByRole('button', { name: '采购管理', exact: true }).click();
    const purchase = p.locator(`.purchase-card[data-purchase-id="${d.purchases[0].id}"]`);
    await purchase.getByRole('combobox').selectOption('已下单');
    await expect
      .poll(async () => (await (await api(c, '/workspace')).json()).data.purchases[0].status)
      .toBe('已下单');
    await undo(p).click();
    await expect
      .poll(async () => (await (await api(c, '/workspace')).json()).data.purchases[0].status)
      .toBe(d.purchases[0].status);
    await redo(p).click();
    await expect
      .poll(async () => (await (await api(c, '/workspace')).json()).data.purchases[0].status)
      .toBe('已下单');
    await p.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await p.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    const dialog = p.getByRole('dialog', { name: '编辑项目', exact: true });
    await dialog.getByLabel('项目备注', { exact: true }).fill('本人普通编辑');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(async () => (await (await api(c, '/workspace')).json()).data.projects[0].notes)
      .toBe('本人普通编辑');
    const state = await (await api(peer, '/workspace')).json();
    state.data.projects[0].notes = '另一员工后续编辑';
    await api(peer, '/workspace', 'PUT', { revision: state.revision, data: state.data });
    await undo(p).click();
    await expect
      .poll(async () => (await (await api(c, '/workspace')).json()).data.projects[0].notes)
      .toBe('另一员工后续编辑');
    await expect
      .poll(async () =>
        (await p.locator('.undo-operation-message,.error-banner').allTextContents()).join(' '),
      )
      .toMatch(/新修改|冲突|已被|核对/);
    expect((await (await api(c, '/workspace')).json()).data.purchases[0].status).toBe('已下单');
  } finally {
    await c.close();
    await peer.close();
  }
});

test('undo of a legacy multi-trade correction restores every original source status without merging or deleting rows', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await login(page, f.login, f.password);
  const d = fixture();
  d.people = [
    {
      id: 'legacy-undo',
      name: '历史师傅',
      role: '施工人员',
      trade: '木工',
      notes: '',
      active: true,
    },
  ];
  await api(page.context(), '/workspace', 'PUT', { revision: 0, data: d });
  const date = assessmentToday(),
    at = new Date().toISOString();
  const original = ['yes', 'no'].map((attendance, index) => ({
    id: crypto.randomUUID(),
    date,
    personId: 'legacy-undo',
    projectId: 'p-home',
    tradeId: d.trades[index].id,
    personName: '历史师傅',
    projectName: d.projects[0].name,
    tradeName: d.trades[index].name,
    attendance,
    photo: 'pending',
    cleaning: 'pending',
    version: 1,
    createdBy: f.id,
    createdName: f.login,
    createdAt: at,
    updatedBy: f.id,
    updatedName: f.login,
    updatedAt: at,
  }));
  // Simulate existing legacy rows only inside the isolated fixture workspace.
  for (const r of original)
    await fixtureQuery(
      'INSERT INTO daily_assessment(workspace_id,id,work_date,person_id,project_id,trade_id,version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        f.workspaceId,
        r.id,
        r.date,
        r.personId,
        r.projectId,
        r.tradeId,
        r.version,
        JSON.stringify(r),
      ],
    );
  await page.reload();
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  const row = page.locator('.assessment-day-row[data-person-id="legacy-undo"]');
  const before = (await page.locator('.assessment-site-card').first().boundingBox())!;
  await row.getByRole('combobox', { name: '历史师傅签到', exact: true }).selectOption('yes');
  const read = async () =>
    (await (await api(page.context(), `/assessments?from=${date}&to=${date}`)).json()).records;
  await expect
    .poll(async () => (await read()).map((r: any) => r.attendance))
    .toEqual(['yes', 'yes']);
  expect((await page.locator('.assessment-site-card').first().boundingBox())!.height).toBe(
    before.height,
  );
  await undo(page).click();
  await expect
    .poll(async () => (await read()).find((r: any) => r.id === original[1].id).attendance)
    .toBe('no');
  await expect(row.getByRole('combobox', { name: '历史师傅签到', exact: true })).toHaveValue(
    'pending',
  );
  const after = await read();
  expect(after).toHaveLength(2);
  for (const old of original) {
    const saved = after.find((r: any) => r.id === old.id);
    expect(saved.createdAt).toBe(old.createdAt);
    expect(saved.personId).toBe(old.personId);
    expect(saved.attendance).toBe(old.attendance);
  }
  await redo(page).click();
  await expect
    .poll(async () => (await read()).map((r: any) => r.attendance))
    .toEqual(['yes', 'yes']);
});
