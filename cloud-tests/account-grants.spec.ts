import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
const origin = 'http://127.0.0.1:5180';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function api(context: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await context.request.get('/api/auth/session')).json();
  return context.request.fetch('/api' + path, {
    method,
    headers: { Origin: origin, 'X-CSRF-Token': s.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function enter(page: Page, login: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
for (const width of [1440, 390])
  test(`employee grants and consistent avatar ${width}px: Chinese login, own profile, audit/directory, no admin bypass`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts();
    const owner = await browser.newContext(),
      staff = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const a = await owner.newPage();
      await enter(a, f.login, f.password);
      expect(
        (await api(owner, '/auth/profile', 'PATCH', { displayName: '工作室负责人' })).status(),
      ).toBe(200);
      const name = '中文员工_' + randomUUID().slice(0, 8);
      const made = await api(owner, '/accounts', 'POST', {
        login: name,
        password: f.password,
        displayName: '员工小陈',
      });
      expect(made.status()).toBe(201);
      const id = (await made.json()).id;
      const p = await staff.newPage();
      await enter(p, name, f.password);
      await p.getByRole('button', { name: '账号管理', exact: true }).click();
      let panel = p.getByRole('dialog', { name: '账号管理', exact: true });
      await expect(panel.getByText('修改登录账号', { exact: true })).toHaveCount(0);
      await expect(panel.getByRole('tab', { name: '备份导入', exact: true })).toHaveCount(0);
      await expect(panel.getByText('本地资料管理', { exact: true })).toHaveCount(0);
      await panel.getByLabel('我的展示名称', { exact: true }).fill('陈工新展示名');
      await panel.getByRole('button', { name: '保存展示名称', exact: true }).click();
      await expect(p.locator('.current-account strong')).toHaveText('陈工新展示名');
      await panel.getByText('头像设置', { exact: true }).click();
      const png = new PNG({ width: 12, height: 20 });
      png.data.fill(170);
      await panel.getByLabel('选择头像', { exact: true }).setInputFiles({
        name: 'employee.png',
        mimeType: 'image/png',
        buffer: PNG.sync.write(png),
      });
      await panel.getByRole('button', { name: '保存头像', exact: true }).click();
      await expect(panel.getByText('头像已保存', { exact: true })).toBeVisible();
      await expect(panel.locator('.account-identity img')).toBeVisible();
      await expect(p.locator('.current-account img')).toBeVisible();
      const source = await panel.locator('.account-identity img').getAttribute('src');
      expect(await p.locator('.current-account img').getAttribute('src')).toBe(source);
      await expect(
        p.locator('.online-member').filter({ has: p.locator(`img[src="${source}"]`) }),
      ).toBeVisible();
      await panel.getByRole('tab', { name: '账号通讯录', exact: true }).click();
      await expect(panel.locator(`[data-member-id="${id}"] .member-card-photo img`)).toBeVisible();
      await expect(
        panel.locator(`[data-member-id="${id}"] .member-card-photo img`),
      ).toHaveAttribute('src', source!);
      await panel.getByLabel('选择账号', { exact: true }).selectOption(f.id);
      await expect(panel.getByLabel('我的私有备注', { exact: true })).toBeVisible();
      await expect(
        panel.getByRole('button', { name: /重置员工密码|停用员工账号|创建员工/ }),
      ).toHaveCount(0);
      await panel.getByRole('tab', { name: '操作记录', exact: true }).click();
      await expect(panel.locator('.audit-events')).toBeVisible();
      await panel.getByRole('button', { name: '筛选记录', exact: true }).click();
      await expect(panel.locator('.audit-events')).toContainText('工作室负责人');
      expect(
        (
          await api(staff, '/auth/login-name', 'POST', {
            newLogin: '越权_' + randomUUID(),
            currentPassword: f.password,
            confirm: true,
          })
        ).status(),
      ).toBe(403);
      for (const [path, data] of [
        ['/accounts/' + f.id, { active: false }],
        ['/accounts/' + id, { role: 'owner' }],
      ] as const)
        expect((await api(staff, path, 'PATCH', data)).status()).toBe(403);
      expect((await api(staff, '/import/preview', 'POST', { archive: {} })).status()).toBe(403);
      expect((await api(staff, '/people/fake/private')).status()).toBe(403);
      await p.reload();
      await expect(p.locator('.current-account img')).toHaveAttribute('src', source!);
      await expect(p.locator('.current-account strong')).toHaveText('陈工新展示名');
      // Current avatar comes from the authenticated profile, not the presence list.
      await p.route('**/api/presence', (route) => route.fulfill({ json: { accounts: [] } }));
      await p.reload();
      await expect(p.locator('.current-account img')).toHaveAttribute('src', source!);
      await p.route('**/api/accounts/*/avatar?*', (route) => route.fulfill({ status: 404 }));
      await p.reload();
      await expect(p.locator('.current-account img')).toHaveCount(0);
      await expect(p.locator('.current-account .account-avatar')).toHaveText('陈');
      await p.getByRole('button', { name: '账号管理', exact: true }).click();
      panel = p.getByRole('dialog', { name: '账号管理', exact: true });
      await expect(panel.locator('.account-identity .account-avatar')).toHaveText('陈');
      await panel.getByText('头像设置', { exact: true }).click();
      await panel.getByRole('button', { name: '恢复默认头像', exact: true }).click();
      await expect(panel.getByText('已恢复默认头像', { exact: true })).toBeVisible();
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await owner.close();
      await staff.close();
    }
  });
