import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
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
for (const width of [1440, 390])
  test(`V4 ${width} avatar preview/upload/reset and live collaboration membership`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts();
    const a = await browser.newContext({ viewport: { width, height: 950 } }),
      b = await browser.newContext(),
      c = await browser.newContext();
    try {
      const p = await a.newPage(),
        peer = await b.newPage();
      await enter(p, f.login, f.password);
      await expect(p.locator('.online-accounts>.account-avatar')).toHaveCount(0);
      await enter(peer, f.employee, f.password);
      await expect.poll(async () => p.locator('.online-accounts .account-avatar').count()).toBe(2);
      await p.getByRole('button', { name: '账号管理', exact: true }).click();
      const panel = p.getByRole('dialog', { name: '账号管理', exact: true });
      await panel.getByText('头像设置', { exact: true }).click();
      const upload = panel.getByLabel('选择头像', { exact: true });
      await upload.setInputFiles({
        name: 'bad.png',
        mimeType: 'image/png',
        buffer: Buffer.from('invalid'),
      });
      await expect(panel.getByRole('alert')).toContainText('图片无法读取');
      await upload.setInputFiles({
        name: 'huge.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(10485761),
      });
      await expect(panel.getByRole('alert')).toContainText('10MB');
      const png = new PNG({ width: 1080, height: 1080 });
      png.data.fill(180);
      await upload.setInputFiles({
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: PNG.sync.write(png),
      });
      await expect(panel.getByRole('img', { name: '头像预览', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '保存头像', exact: true }).click();
      await expect(panel.getByText('头像已保存', { exact: true })).toBeVisible();
      await p.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await expect(p.locator('.current-account img')).toBeVisible();
      await expect(peer.locator('.online-accounts img')).toBeVisible({ timeout: 12000 });
      await p.getByRole('button', { name: '账号管理', exact: true }).click();
      await panel.getByText('头像设置', { exact: true }).click();
      await panel.getByRole('button', { name: '恢复默认头像', exact: true }).click();
      await expect(panel.getByText('已恢复默认头像', { exact: true })).toBeVisible();
      await p.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await expect(p.locator('.current-account img')).toHaveCount(0);
      const identity = await (await a.request.get('/api/auth/session')).json();
      const login = 'online_' + randomUUID();
      const created = await a.request.post('/api/accounts', {
        headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': identity.csrf },
        data: { login, password: f.password, displayName: '第三位协作者' },
      });
      expect(created.status()).toBe(201);
      // Creating an account alone must not display it as online.
      expect((await (await a.request.get('/api/presence')).json()).accounts).toHaveLength(2);
      const third = await c.newPage();
      await enter(third, login, f.password);
      await expect
        .poll(async () => p.locator('.online-accounts .account-avatar').count())
        .toBe(width === 390 ? 2 : 3);
      if (width === 390) await expect(p.locator('.online-more')).toHaveText('+1');
      await third.close();
      await peer.close();
      await expect.poll(async () => p.locator('.online-accounts .account-avatar').count()).toBe(1);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await a.close();
      await b.close();
      await c.close();
    }
  });
