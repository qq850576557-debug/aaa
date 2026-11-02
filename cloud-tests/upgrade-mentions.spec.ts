import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { today, plus } from '../src/lib/model';
import { mkdir } from 'node:fs/promises';
async function api(p: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return p.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
async function enter(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
async function seed(p: Page) {
  const d = fixture();
  expect((await api(p, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  await p.reload();
  await expect(p.locator('.task-bar').first()).toBeVisible();
  return d;
}
test('empty category switches are free; changed common fields survive confirmed switching and required dates prevent orphans', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  const d = await seed(page);
  await page
    .getByTestId('today-panel')
    .getByRole('button', { name: '添加今日事项', exact: true })
    .click();
  const dialog = page.locator('.agenda-entry-dialog');
  for (const name of ['采购清单', '事项管理', '采购清单', '事项管理']) {
    await dialog.getByRole('radio', { name, exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '放弃当前未保存的内容？', exact: true }),
    ).toHaveCount(0);
  }
  await dialog.getByLabel('任务事项', { exact: true }).fill('切换后保留的现场记录');
  await dialog.getByLabel('记录节点日期', { exact: true }).fill(plus(today(), 1));
  await dialog.getByLabel('记录备注', { exact: true }).fill('完整保留这段备注');
  await dialog.getByRole('radio', { name: '采购清单', exact: true }).click();
  let confirm = page.getByRole('dialog', { name: '放弃当前未保存的内容？', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog.getByLabel('任务事项', { exact: true })).toHaveValue('切换后保留的现场记录');
  await dialog.getByRole('radio', { name: '采购清单', exact: true }).click();
  await confirm.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(dialog.getByLabel('采购内容 / 事项标题', { exact: true })).toHaveValue(
    '切换后保留的现场记录',
  );
  await expect(dialog.getByLabel('采购截止日期', { exact: true })).toHaveValue(plus(today(), 1));
  await expect(dialog.getByLabel('详细备注（可选）', { exact: true })).toHaveValue(
    '完整保留这段备注',
  );
  await dialog.getByRole('radio', { name: '事项管理', exact: true }).click();
  await confirm.getByRole('button', { name: '确认操作', exact: true }).click();
  await dialog.getByLabel('记录节点日期', { exact: true }).fill('');
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect((await api(page, '/records')).value.records).toHaveLength(0);
  await dialog.getByLabel('记录节点日期', { exact: true }).fill(plus(today(), 1));
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('today-panel')).toBeVisible();
  const records = (await api(page, '/records')).value.records;
  expect(records).toHaveLength(1);
  expect(records[0].nodeDate).toBe(plus(today(), 1));
  expect(records[0].notes).toBe('完整保留这段备注');
  expect((await api(page)).value.data.purchases).toEqual(
    d.purchases.map((p: any) => expect.objectContaining(p)),
  );
});
test('two employees receive independent realtime @ messages, open the current record and keep unread state across reload', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts(),
    ca = await browser.newContext(),
    cb = await browser.newContext(),
    a = await ca.newPage(),
    b = await cb.newPage();
  try {
    await enter(a, f.login, f.password);
    await seed(a);
    await enter(b, f.employee, f.password);
    await a.getByRole('button', { name: '事项管理', exact: true }).click();
    await a
      .locator('.board-tool-primary')
      .getByRole('button', { name: '新增记录', exact: true })
      .click();
    const drawer = a.locator('.record-drawer');
    await drawer.getByLabel('记录所属项目', { exact: true }).selectOption('p-home');
    await drawer.getByLabel('任务事项', { exact: true }).fill('多人现场联合核验');
    await drawer.getByLabel('记录节点日期', { exact: true }).fill(today());
    const search = drawer.getByLabel('事项负责人', { exact: true });
    await search.fill('历史负责人 @' + f.employee);
    await drawer.locator('.mention-options button').filter({ hasText: f.employee }).click();
    await search.fill('历史负责人 @' + f.login);
    await drawer.locator('.mention-options button').filter({ hasText: f.login }).click();
    await expect(drawer.locator('.mention-selected button')).toHaveCount(2);
    await search.fill('历史负责人 @' + f.employee);
    await expect(drawer.locator('.mention-options button')).toHaveCount(0);
    await search.press('Escape');
    await search.fill('历史负责人 ');
    await expect(drawer.getByText('同时@负责人', { exact: true })).toHaveCount(0);
    await mkdir('/tmp/chunmo-upgrade-ui', { recursive: true });
    await a.screenshot({ path: '/tmp/chunmo-upgrade-ui/multi-mention-1440.png' });
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(b.getByRole('button', { name: '我的@消息，1条未读', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: '我的@消息，1条未读', exact: true })).toBeVisible();
    await b.reload();
    await expect(b.getByRole('button', { name: '我的@消息，1条未读', exact: true })).toBeVisible();
    await b.getByRole('button', { name: '我的@消息，1条未读', exact: true }).click();
    const inbox = b.getByRole('dialog', { name: '我的@消息', exact: true });
    await expect(inbox).toContainText('多人现场联合核验');
    await expect(inbox).toHaveCSS('opacity', '1');
    await b.screenshot({ path: '/tmp/chunmo-upgrade-ui/inbox-1440.png' });
    await inbox.locator('.mention-notice>button').first().click();
    await expect(inbox).toHaveCount(0);
    await expect(b.locator('.record-drawer')).toBeVisible();
    await expect(b.locator('.record-drawer').getByLabel('任务事项', { exact: true })).toHaveValue(
      '多人现场联合核验',
    );
    await expect(b.locator('.record-drawer').getByLabel('事项负责人', { exact: true })).toHaveValue(
      '历史负责人 ',
    );
    await expect(b.locator('.record-drawer .mention-selected button')).toHaveCount(2);
    await b.locator('.record-drawer .mention-selected button').first().click();
    await expect(b.locator('.record-drawer .mention-selected button')).toHaveCount(1);
    await b
      .locator('.record-drawer')
      .getByRole('button', { name: '保存记录', exact: true })
      .click();
    await expect(b.locator('.record-drawer')).toHaveCount(0);
    await expect
      .poll(async () => {
        const saved = (await api(b, '/records')).value.records.find(
          (r: any) => r.title === '多人现场联合核验',
        );
        return { owner: saved?.owner, mentions: saved?.mentionIds?.length };
      })
      .toEqual({ owner: '历史负责人 ', mentions: 1 });
    await expect(b.getByRole('button', { name: '我的@消息', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: '我的@消息，1条未读', exact: true })).toBeVisible();
  } finally {
    await ca.close();
    await cb.close();
  }
});
test('materials UI is paused while project, purchase, notes and history counts stay intact', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  const before = await api(page);
  await expect(page.getByRole('button', { name: '材料资产管理', exact: true })).toHaveCount(0);
  for (const name of ['采购管理', '事项管理', '提醒中心', '项目工作空间'])
    await page.getByRole('button', { name, exact: true }).click();
  const after = await api(page);
  expect(after.value).toEqual(before.value);
  expect((await api(page, '/upgrade-data-preview')).value.totals).toMatchObject({
    projects: 1,
    tasks: 3,
    notes: 2,
    purchases: 1,
  });
});

test('procurement multi-mention survives save/reload, sends one notice per account and opens the current purchase', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page.getByRole('button', { name: '新增采购', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '新建采购事项', exact: true });
  await modal.getByLabel('采购内容 / 事项标题', { exact: true }).fill('多人跟进灯具到货');
  const picker = modal.getByLabel('@负责人搜索', { exact: true });
  await picker.fill('@' + f.employee);
  await modal.locator('.mention-options button').filter({ hasText: f.employee }).click();
  await picker.fill('@' + f.login);
  await modal.locator('.mention-options button').filter({ hasText: f.login }).click();
  await picker.press('Escape');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText('已保存');
  await expect(page.getByRole('heading', { name: '材料采购管理', exact: true })).toBeVisible();
  const all = (await api(page)).value.data.purchases,
    record = all.find((p: any) => p.name === '多人跟进灯具到货');
  expect(record.mentionIds).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('button', { name: '我的@消息，1条未读', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的@消息，1条未读', exact: true }).click();
  const inbox = page.getByRole('dialog', { name: '我的@消息', exact: true });
  await expect(inbox).toContainText('采购');
  await inbox.locator('.mention-notice>button').first().click();
  const editor = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.locator('.mention-selected button')).toHaveCount(2);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await api(page, '/notifications')).value.notifications).toHaveLength(1);
});

test('an account disabled after selection preserves the rejected purchase draft without blocking a project save', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page
    .locator('.purchase-card')
    .first()
    .getByRole('button', { name: /编辑采购/ })
    .click();
  let editor = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
  const picker = editor.getByLabel('@负责人搜索', { exact: true });
  await picker.fill('@' + f.employee);
  await editor.locator('.mention-options button').filter({ hasText: f.employee }).click();
  await picker.press('Escape');
  const accounts = (await api(page, '/mention-accounts')).value.accounts,
    employee = accounts.find((a: any) => a.login === f.employee);
  expect((await api(page, '/accounts/' + employee.id, 'PATCH', { active: false })).status).toBe(
    200,
  );
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText(/部分未保存|保存失败/);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const project = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await project.getByLabel('项目备注', { exact: true }).fill('其他资源继续正常保存');
  await project.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await api(page)).value.data.projects[0].notes)
    .toBe('其他资源继续正常保存');
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page
    .locator('.purchase-card')
    .first()
    .getByRole('button', { name: /编辑采购/ })
    .click();
  editor = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
  await expect(editor.locator('.mention-selected button')).toHaveCount(1);
  await editor.locator('.mention-selected button').click();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await api(page, '/notifications')).value.notifications).toHaveLength(0);
  expect((await api(page)).value.data.purchases[0].mentionIds).toEqual([]);
});

test('account panel shows verified identity immediately but late session reads cannot overwrite typed input or bypass write verification', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let writes = 0;
  await page.route('**/api/auth/session', async (route) => {
    await gate;
    await route.continue();
  });
  await page.route('**/api/auth/profile', async (route) => {
    if (route.request().method() === 'PATCH') writes++;
    await route.continue();
  });
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '账号管理', exact: true });
  await expect(panel.locator('.account-identity')).toBeVisible();
  await panel.getByLabel('我的展示名称', { exact: true }).fill('不会被迟到读取覆盖');
  await panel.getByRole('button', { name: '保存展示名称', exact: true }).click();
  await expect(panel.getByRole('button', { name: '保存展示名称', exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  release();
  await expect(panel).toContainText('展示名称已保存');
  await expect(panel.getByLabel('我的展示名称', { exact: true })).toHaveValue('不会被迟到读取覆盖');
  expect(writes).toBe(1);
});
