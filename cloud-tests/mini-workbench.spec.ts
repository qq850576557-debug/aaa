import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createMiniPhotoSidecar } from '../server/miniprogram-sidecar';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { Api, WorkbenchClient, miniRuntime } from '../tests/support/mini-runtime';
let sidecar: Server, restore: () => void;
test.beforeAll(async () => {
  sidecar = createServer(
    createMiniPhotoSidecar({
      enabled: true,
      workbenchEnabled: true,
      appId: 'wx1234567890abcdef',
      appSecret: 'test-only',
      signingKey: 'isolated-test-only-'.repeat(4),
      origin: 'http://127.0.0.1:5180',
      apiPort: 4001,
      exchange: async () => ({ openid: 'test-only' }),
    }),
  );
  await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', r));
  restore = miniRuntime(
    'http://127.0.0.1:' + (sidecar.address() as any).port,
    'wx1234567890abcdef',
  );
});
test.afterAll(async () => {
  restore?.();
  if (sidecar) {
    sidecar.closeAllConnections();
    await new Promise<void>((r) => sidecar.close(() => r()));
  }
  await pool.end();
  await privatePool.end();
});
test('desktop purchase form → actual Mini client → desktop live status update', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const data = fixture();
  data.purchases = [];
  data.notes = [];
  const seeded = await page.evaluate(async (data) => {
    const s = await (await fetch('/api/auth/session')).json();
    return (
      await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-CSRF-Token': s.csrf },
        body: JSON.stringify({ revision: 0, data }),
      })
    ).status;
  }, data);
  expect(seeded).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page.getByRole('button', { name: '新增采购', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建采购事项', exact: true });
  await form.getByLabel('采购内容 / 事项标题', { exact: true }).fill('跨端闭环电线');
  await form.getByLabel('规格型号', { exact: true }).fill('2.5平方');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.purchase-list')).toContainText('跨端闭环电线');
  await expect(page.locator('.save-state')).toContainText('已保存');
  const api = new Api();
  await api.login(f.employee, f.password);
  const mini = new WorkbenchClient(api, { get: () => undefined, set: () => {} });
  await mini.refresh();
  const purchase = mini.state.data.purchases.find((p: any) => p.name === '跨端闭环电线');
  expect(purchase).toBeTruthy();
  mini.purchase({ status: '已下单' }, purchase.id);
  await mini.flush();
  const card = page.locator('.purchase-card').filter({ hasText: '跨端闭环电线' });
  await expect(card.locator('select')).toHaveValue('已下单');
  await expect
    .poll(async () => {
      await mini.refresh();
      return mini.state.data.purchases.filter((p: any) => p.id === purchase.id).length;
    })
    .toBe(1);
  await page.screenshot({
    path: 'docs/workbench/screenshots/desktop-closed-loop.png',
    fullPage: true,
  });
});
