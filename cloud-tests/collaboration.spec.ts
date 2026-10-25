import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { readFile } from 'node:fs/promises';
let accounts: Awaited<ReturnType<typeof fixtureAccounts>>;
test.beforeAll(async () => {
  accounts = await fixtureAccounts();
});
test.afterAll(async () => {
  await pool.end();
  await privatePool.end();
});
async function enter(page: Page, login: string) {
  await page.goto('/');
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '连接云空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '云端账号与工作空间', exact: true });
  await dialog.getByLabel('登录账号', { exact: true }).fill(login);
  await dialog.getByLabel('登录密码', { exact: true }).fill(accounts.password);
  await dialog.getByRole('button', { name: '登录云端', exact: true }).click();
  await dialog.getByRole('button', { name: '进入云空间', exact: true }).click();
  await expect(page.locator('.local-notice')).toContainText('云空间');
  await expect(page.locator('.save-state')).toContainText('已保存');
}
async function clientApi(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const user = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': user.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json() };
    },
    { path, method, body },
  );
}
async function editor(page: Page) {
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  return page.getByRole('dialog', { name: '编辑项目', exact: true });
}
test('two real accounts: API-backed saves, SSE, dirty-form conflict, explicit resync, trusted history, private API denial, logout and original IndexedDB preservation', async ({
  browser,
}) => {
  const aContext = await browser.newContext(),
    bContext = await browser.newContext();
  const a = await aContext.newPage(),
    b = await bContext.newPage();
  await enter(a, accounts.login);
  await enter(b, accounts.employee);
  await a.getByRole('button', { name: '新建项目', exact: true }).click();
  let form = a.getByRole('dialog', { name: '新建项目', exact: true });
  await form.getByLabel('项目名称', { exact: true }).fill('多人云端工地');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(a.locator('.save-state')).toContainText('已保存');
  await expect(b.locator('.project-info h2')).toHaveText('多人云端工地', { timeout: 10000 });
  const before = await clientApi(a, '/workspace');
  const aForm = await editor(a),
    bForm = await editor(b);
  await aForm.getByLabel('项目名称', { exact: true }).fill('负责人更新');
  await bForm.getByLabel('项目名称', { exact: true }).fill('员工旧版草稿');
  await aForm.getByRole('button', { name: '保存', exact: true }).click();
  await expect(a.locator('.save-state')).toContainText('已保存');
  await b.waitForTimeout(1500);
  await bForm.getByRole('button', { name: '保存', exact: true }).click();
  await expect(b.locator('.save-state')).toContainText('保存冲突');
  expect((await clientApi(a, '/workspace')).body.data.projects[0].name).toBe('负责人更新');
  await expect(b.locator('.project-info h2')).toHaveText('员工旧版草稿');
  await b.getByRole('button', { name: '重新读取云端', exact: true }).click();
  await b.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(b.locator('.project-info h2')).toHaveText('负责人更新');
  form = await editor(b);
  await form.getByLabel('项目备注', { exact: true }).fill('普通员工同步修改');
  await form.getByLabel('项目名称', { exact: true }).fill('员工实时更新');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(b.locator('.save-state')).toContainText('已保存');
  await expect(a.locator('.project-info h2')).toHaveText('员工实时更新', { timeout: 10000 });
  await expect
    .poll(async () => (await clientApi(a, '/workspace')).body.data.projects[0].notes)
    .toBe('普通员工同步修改');
  await expect.poll(async () => a.locator('.save-state').textContent()).toContain('已保存');
  const state = (await clientApi(a, '/workspace')).body;
  expect(state.revision).toBeGreaterThan(before.body.revision);
  expect(state.history.records.some((r: any) => r.actorId === accounts.employeeId)).toBe(true);
  const publicPerson = {
    id: 'cloud-worker',
    name: '云端师傅',
    role: '施工人员',
    trade: '水电',
    notes: '',
    active: true,
  };
  state.data.people = [publicPerson];
  expect(
    (await clientApi(a, '/workspace', 'PUT', { revision: state.revision, data: state.data }))
      .status,
  ).toBe(200);
  const phone = '+8613800000000';
  expect(
    (await clientApi(a, '/people/cloud-worker/private', 'PUT', { phone, birthDate: '1990-01-01' }))
      .status,
  ).toBe(200);
  expect((await clientApi(b, '/people/cloud-worker/private')).status).toBe(403);
  expect(JSON.stringify((await clientApi(b, '/export')).body)).not.toContain(phone);
  await a.reload();
  await expect(a.locator('.local-notice')).toContainText('云空间');
  await expect(a.locator('.project-info h2')).toHaveText('员工实时更新');
  const local = await a.evaluate(
    async () =>
      await new Promise<any>((resolve, reject) => {
        const q = indexedDB.open('chunmo-workspace', 1);
        q.onsuccess = () => {
          const db = q.result,
            r = db.transaction('workspace').objectStore('workspace').get('data');
          r.onsuccess = () => {
            resolve(r.result);
            db.close();
          };
          r.onerror = () => reject(r.error);
        };
      }),
  );
  expect(local).toBeUndefined();
  await b.getByRole('button', { name: '云端账号', exact: true }).click();
  const account = b.getByRole('dialog', { name: '云端账号与工作空间' });
  await account.getByRole('button', { name: '检查现有云端会话' }).click();
  await expect(account).toContainText(accounts.employee);
  await account.getByRole('button', { name: '退出登录并返回本地' }).click();
  await expect(b.locator('.local-notice')).toContainText('本地模式');
  expect((await b.request.get('/api/workspace')).status()).toBe(401);
  await aContext.close();
  await bContext.close();
});
test('owner-controlled import from a real local backup previews and commits without deleting browser data; duplicate is idempotent', async ({
  browser,
}) => {
  const context = await browser.newContext(),
    p = await context.newPage();
  await p.goto('/');
  await expect(p.locator('.save-state')).toContainText('已保存');
  const archive = fixture();
  archive.projects[0].id = 'import-project';
  for (const key of ['trades', 'tasks', 'notes', 'purchases'] as const)
    for (const row of archive[key]) row.projectId = 'import-project';
  archive.people = [];
  await p.getByRole('button', { name: '数据与备份', exact: true }).click();
  await p.locator('input[type=file]').setInputFiles({
    name: 'local.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await p.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(p.locator('.project-info h2')).toHaveText(archive.projects[0].name);
  await expect(p.locator('.save-state')).toContainText('已保存');
  await p.getByRole('button', { name: '数据与备份', exact: true }).click();
  const download = p.waitForEvent('download');
  await p.getByRole('button', { name: '下载业务与版本备份', exact: true }).click();
  const file = await download,
    bytes = await readFile((await file.path())!);
  await p.getByRole('button', { name: '关闭', exact: true }).click();
  await p.getByRole('button', { name: '连接云空间', exact: true }).click();
  let account = p.getByRole('dialog', { name: '云端账号与工作空间' });
  await account.getByLabel('登录账号', { exact: true }).fill(accounts.login);
  await account.getByLabel('登录密码', { exact: true }).fill(accounts.password);
  await account.getByRole('button', { name: '登录云端', exact: true }).click();
  await account.getByText('导入本地业务与版本备份', { exact: true }).click();
  await account
    .getByLabel('选择云端导入备份')
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(account).toContainText('校验预览');
  await expect(p.locator('.project-info h2')).toHaveText(archive.projects[0].name);
  await account.getByRole('button', { name: '确认导入预览', exact: true }).click();
  await p.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(account).toContainText('导入成功');
  await account
    .getByLabel('选择云端导入备份')
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(account).toContainText('此备份已导入');
  await account.getByRole('button', { name: '进入云空间', exact: true }).click();
  await expect(p.locator('.local-notice')).toContainText('云空间');
  await expect(p.getByLabel('切换项目', { exact: true }).locator('option')).toHaveCount(2);
  await p.getByLabel('切换项目', { exact: true }).selectOption('import-project');
  await expect(p.getByTestId('task-bar')).toHaveCount(3);
  await p.locator('.project-history-entry button').click();
  await expect(p.getByRole('dialog', { name: '最近15天修改历史' })).toContainText('导入记录');
  await p.getByRole('button', { name: '关闭', exact: true }).click();
  await p.getByRole('button', { name: '云端账号', exact: true }).click();
  account = p.getByRole('dialog', { name: '云端账号与工作空间' });
  await account.getByRole('button', { name: '检查现有云端会话' }).click();
  await account.getByRole('button', { name: '退出登录并返回本地' }).click();
  await expect(p.locator('.project-info h2')).toHaveText(archive.projects[0].name);
  await expect(p.getByTestId('task-bar')).toHaveCount(3);
  await context.close();
});

test('cloud purchase deadline confirmation uses owner API, preserves baseline and is unavailable to employee UI', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext(),
    employeeContext = await browser.newContext();
  const a = await ownerContext.newPage(),
    b = await employeeContext.newPage();
  await enter(a, accounts.login);
  const before = (await clientApi(a, '/workspace')).body;
  const original = before.data.purchases.find((p: any) => p.name === '电线及线管').originalDue;
  await a
    .getByRole('navigation')
    .getByRole('button', { name: /^提醒中心/ })
    .click();
  await a.getByRole('button', { name: '编辑采购电线及线管', exact: true }).click();
  await a
    .getByRole('dialog', { name: '编辑采购事项', exact: true })
    .getByRole('button', { name: '变更原定期限', exact: true })
    .click();
  const dialog = a.getByRole('dialog', { name: '确认变更原定采购期限', exact: true });
  await expect(dialog).toContainText('云端模式');
  await dialog.getByLabel('新的最晚采购期限', { exact: true }).fill('2026-11-01');
  await dialog.getByLabel('变更原因', { exact: true }).fill('负责人确认供应计划');
  await dialog.getByRole('button', { name: '确认变更期限', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await clientApi(a, '/workspace')).body.data.purchases.find(
    (p: any) => p.name === '电线及线管',
  );
  expect(saved.originalDue).toBe(original);
  expect(saved.approvedDue).toBe('2026-11-01');
  expect(saved.deadlineHistory.at(-1).reason).toBe('负责人确认供应计划');
  await enter(b, accounts.employee);
  await b
    .getByRole('navigation')
    .getByRole('button', { name: /^提醒中心/ })
    .click();
  await b.getByRole('button', { name: '编辑采购电线及线管', exact: true }).click();
  await expect(
    b
      .getByRole('dialog', { name: '编辑采购事项', exact: true })
      .getByRole('button', { name: '变更原定期限', exact: true }),
  ).toHaveCount(0);
  await ownerContext.close();
  await employeeContext.close();
});

test('password panel: employee self-change, owner employee reset and owner self-change require fresh login with 8-character passwords', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const f = await fixtureAccounts();
  const ownerContext = await browser.newContext(),
    staffContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage(),
    staffPage = await staffContext.newPage();
  async function panel(page: Page, login: string, password: string) {
    await page.goto('/');
    await page.getByRole('button', { name: '连接云空间', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '云端账号与工作空间' });
    await signIn(dialog, login, password);
    await dialog.getByRole('button', { name: '进入云空间', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '云端账号', exact: true }).click();
    await dialog.getByRole('button', { name: '检查现有云端会话' }).click();
    await expect(dialog.getByText('修改我的密码', { exact: true })).toBeVisible();
    return dialog;
  }
  async function signIn(
    dialog: ReturnType<Page['getByRole']>,
    login: string,
    password: string,
    cloudPage?: Page,
  ) {
    await dialog.getByLabel('登录账号', { exact: true }).fill(login);
    await dialog.getByLabel('登录密码', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '登录云端', exact: true }).click();
    if (cloudPage) {
      await expect(dialog).not.toBeVisible();
      await expect(cloudPage.locator('.save-state')).toContainText('已保存');
      await cloudPage.getByRole('button', { name: '云端账号', exact: true }).click();
      await dialog.getByRole('button', { name: '检查现有云端会话' }).click();
    }
    await expect(dialog.getByText('修改我的密码', { exact: true })).toBeVisible();
  }
  try {
    const ownerPanel = await panel(ownerPage, f.login, f.password);
    const staffPanel = await panel(staffPage, f.employee, f.password);
    await expect(staffPanel.getByText('员工账号管理', { exact: true })).toHaveCount(0);
    await staffPanel.getByText('修改我的密码', { exact: true }).click();
    await expect(staffPanel.getByLabel('新密码', { exact: true })).toHaveAttribute(
      'minlength',
      '8',
    );
    await expect(staffPanel.getByLabel('新密码', { exact: true })).toHaveAttribute(
      'maxlength',
      '128',
    );
    await staffPanel.getByLabel('当前密码', { exact: true }).fill('wrongpwd');
    await staffPanel.getByLabel('新密码', { exact: true }).fill('aaaaaaaa');
    await staffPanel.getByLabel('确认新密码', { exact: true }).fill('bbbbbbbb');
    await staffPanel.getByRole('button', { name: '保存我的新密码' }).click();
    await expect(staffPanel.getByRole('alert')).toContainText('两次输入的新密码不一致');
    await staffPanel.getByLabel('确认新密码', { exact: true }).fill('aaaaaaaa');
    await staffPanel.getByRole('button', { name: '保存我的新密码' }).click();
    await expect(staffPanel.getByRole('alert')).toContainText('当前密码不正确');
    await staffPanel.getByLabel('当前密码', { exact: true }).fill(f.password);
    await staffPanel.getByRole('button', { name: '保存我的新密码' }).click();
    await expect(staffPanel.getByRole('status')).toContainText('全部旧会话已撤销');
    expect((await staffPage.request.get('/api/auth/session')).status()).toBe(401);
    await signIn(staffPanel, f.employee, 'aaaaaaaa', staffPage);
    await ownerPanel.getByText('员工账号管理', { exact: true }).click();
    await ownerPanel.getByRole('button', { name: '加载员工账号' }).click();
    await ownerPanel.getByLabel('选择员工账号').selectOption(f.employeeId);
    const resetForm = ownerPanel.getByRole('form', { name: '重置员工密码', exact: true });
    await resetForm.getByLabel('新密码', { exact: true }).fill('bbbbbbbb');
    await resetForm.getByLabel('确认新密码', { exact: true }).fill('bbbbbbbb');
    await resetForm.getByRole('button', { name: '重置员工密码' }).click();
    await expect(ownerPanel.getByRole('status')).toContainText('员工密码已重置');
    expect((await staffPage.request.get('/api/auth/session')).status()).toBe(401);
    await staffPanel.getByText('修改我的密码', { exact: true }).click();
    await staffPanel.getByLabel('当前密码', { exact: true }).fill('aaaaaaaa');
    await staffPanel.getByLabel('新密码', { exact: true }).fill('dddddddd');
    await staffPanel.getByLabel('确认新密码', { exact: true }).fill('dddddddd');
    await staffPanel.getByRole('button', { name: '保存我的新密码' }).click();
    await expect(staffPanel.getByRole('status')).toContainText('会话已失效');
    await signIn(staffPanel, f.employee, 'bbbbbbbb', staffPage);
    await expect(staffPanel).toContainText('普通员工');
    // Close the reset section to avoid duplicate hidden new-password fields.
    await ownerPanel.getByText('员工账号管理', { exact: true }).click();
    await ownerPanel.getByText('修改我的密码', { exact: true }).click();
    const selfForm = ownerPanel.getByRole('form', { name: '修改我的密码', exact: true });
    await selfForm.getByLabel('当前密码', { exact: true }).fill(f.password);
    await selfForm.getByLabel('新密码', { exact: true }).fill('cccccccc');
    await selfForm.getByLabel('确认新密码', { exact: true }).fill('cccccccc');
    await selfForm.getByRole('button', { name: '保存我的新密码' }).click();
    await expect(ownerPanel.getByRole('status')).toContainText('全部旧会话已撤销');
    await signIn(ownerPanel, f.login, 'cccccccc', ownerPage);
    await expect(ownerPanel).toContainText('工作室负责人');
  } finally {
    await ownerContext.close();
    await staffContext.close();
  }
});
