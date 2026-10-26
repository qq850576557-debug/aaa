import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
const origin = 'http://127.0.0.1:5180';
for (const width of [1440, 390])
  for (const owner of [true, false])
    test(`login rename ${width}px ${owner ? 'owner' : 'employee'}: password confirmation, Chinese login, revoked sessions and cooldown`, async ({
      browser,
    }) => {
      const f = await fixtureAccounts();
      const old = owner ? f.login : f.employee;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
        ...(width === 390
          ? {
              userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
            }
          : {}),
      });
      try {
        const page = await context.newPage();
        await page.goto('/');
        await page.getByLabel('登录账号', { exact: true }).fill(old);
        await page.getByLabel('登录密码', { exact: true }).fill(f.password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.locator('.save-state')).toContainText('已保存');
        await page.getByRole('button', { name: '账号管理', exact: true }).click();
        let panel = page.getByRole('dialog', { name: '账号管理', exact: true });
        await expect(panel.getByRole('tab', { name: '账号与安全', exact: true })).toBeVisible();
        const formal = owner ? '马春旭' : '水电王师傅';
        await panel.getByLabel('我的展示名称', { exact: true }).fill(formal);
        await panel.getByRole('button', { name: '保存展示名称', exact: true }).click();
        await expect(panel.getByRole('heading', { name: formal, exact: true })).toBeVisible();
        await panel.getByText('修改登录账号', { exact: true }).click();
        const editor = panel.locator('.login-name-editor');
        await expect(editor).toContainText(old);
        await expect(editor).toContainText('现在可修改');
        const input =
          (width === 390 ? '中文账号'.repeat(12) : '春茉') + '_ＭＡ_' + randomUUID().slice(0, 8);
        const canonical = input.normalize('NFKC').toLowerCase();
        await editor.getByLabel('新登录账号', { exact: true }).fill(input);
        await editor.getByRole('button', { name: '继续修改登录账号' }).click();
        let dialog = page.getByRole('dialog', { name: '确认修改登录账号', exact: true });
        await expect(dialog).toContainText(old);
        await expect(dialog).toContainText(canonical);
        await expect(dialog).toContainText('修改后90天内无法再次修改，原账号将无法继续登录');
        const bounds = (await dialog.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        expect((await context.request.get('/api/auth/session')).status()).toBe(200);
        await editor.getByRole('button', { name: '继续修改登录账号' }).click();
        dialog = page.getByRole('dialog', { name: '确认修改登录账号', exact: true });
        await expect(dialog.getByLabel('当前登录密码')).toHaveValue('');
        await dialog.getByLabel('当前登录密码').fill('wrongpwd');
        await dialog.getByRole('button', { name: '确认修改并退出登录' }).click();
        await expect(dialog.getByRole('alert')).toContainText('当前密码不正确');
        await dialog.getByLabel('当前登录密码').fill(f.password);
        await page.screenshot({
          path: `/tmp/chunmo-login-name-${width}-${owner ? 'owner' : 'employee'}.png`,
        });
        await dialog.getByRole('button', { name: '确认修改并退出登录' }).click();
        await expect(page.locator('.brand-login')).toBeVisible();
        await expect(page.getByLabel('登录账号', { exact: true })).toHaveValue(canonical);
        expect((await context.request.get('/api/auth/session')).status()).toBe(401);
        expect(
          (
            await context.request.post('/api/auth/login', {
              headers: { Origin: origin },
              data: { login: old, password: f.password },
            })
          ).status(),
        ).toBe(401);
        await page.getByLabel('登录密码', { exact: true }).fill(f.password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.locator('.save-state')).toContainText('已保存');
        const current = await (await context.request.get('/api/auth/session')).json();
        expect(current.user.id).toBe(owner ? f.id : f.employeeId);
        expect(current.user.owner).toBe(owner);
        await page.getByRole('button', { name: '账号管理', exact: true }).click();
        panel = page.getByRole('dialog', { name: '账号管理', exact: true });
        await expect(panel.getByLabel('我的展示名称', { exact: true })).toHaveValue(formal);
        await panel.getByText('修改登录账号', { exact: true }).click();
        await expect(panel.locator('.login-name-editor')).toContainText('90天冷却期');
        await expect(panel.getByRole('button', { name: '继续修改登录账号' })).toBeDisabled();
        await expect(panel.locator('.login-policy')).toContainText(canonical);
      } finally {
        await context.close();
      }
    });
