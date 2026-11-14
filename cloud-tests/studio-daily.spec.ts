import { test, expect } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { mkdir } from 'node:fs/promises';
test.afterAll(async () => {
  await pool.end();
  await privatePool.end();
});
test('desktop home session folds, owner daily requirements and weekly duty persist', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await mkdir('docs/screenshots/studio-home-v2', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/studio-home-v2/home-empty.png', fullPage: true });
  await expect(page.getByRole('button', { name: '收起今日事项', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: '收起今日事项', exact: true }).click();
  await expect(page.getByRole('button', { name: '收起明日提醒', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开今日事项', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '收起今日事项', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理每日必做', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '管理每日必做', exact: true });
  await modal.getByRole('button', { name: '新增工作要求', exact: true }).click();
  await modal.getByLabel('工作要求', { exact: true }).fill('隔离测试工作要求');
  await modal.getByLabel('周六', { exact: true }).check();
  await modal.getByLabel('周日', { exact: true }).check();
  await modal.getByLabel(f.employee, { exact: true }).check();
  await modal.screenshot({ path: 'docs/screenshots/studio-home-v2/rules-manager.png' });
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('studio-rules')).toContainText('隔离测试工作要求');
  await page.getByRole('button', { name: '编辑值日安排', exact: true }).click();
  modal = page.getByRole('dialog', { name: '编辑值日安排', exact: true });
  await modal.getByLabel('值日内容', { exact: true }).fill('隔离测试卫生说明');
  await modal
    .locator('article')
    .filter({ hasText: '每周六' })
    .getByLabel(f.employee, { exact: true })
    .check();
  await modal.screenshot({ path: 'docs/screenshots/studio-home-v2/duty-manager.png' });
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '查看本周排班', exact: true }).click();
  await page.screenshot({
    path: 'docs/screenshots/studio-home-v2/home-with-week.png',
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByTestId('studio-rules')).toContainText('隔离测试工作要求');
  await expect(page.getByText('隔离测试卫生说明', { exact: true })).toBeVisible();
});

test('home shows all cards and same-site purchase status never changes site background', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const { fixture } = await import('../tests/helpers');
  const data = fixture();
  data.notes = [];
  data.purchases = Array.from({ length: 12 }, (_, i) => ({
    ...data.purchases[0],
    id: 'studio-color-' + i,
    taskId: '',
    deadlineMode: 'fixed' as const,
    due: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    originalDue: undefined,
    approvedDue: undefined,
    status: i % 2 ? ('已完成' as const) : ('待采购' as const),
  }));
  const r = await page.evaluate(async (data) => {
    const s = await (await fetch('/api/auth/session')).json();
    return (
      await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        body: JSON.stringify({ revision: 0, data }),
      })
    ).status;
  }, data);
  expect(r).toBe(200);
  await page.reload();
  const cards = page.getByTestId('today-panel').locator('.agenda-item');
  await expect(cards).toHaveCount(12);
  expect(await cards.nth(0).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
    await cards.nth(1).evaluate((e) => getComputedStyle(e).backgroundColor),
  );
  const content = page.getByTestId('today-panel').locator('.brief-content');
  expect(await content.evaluate((e) => e.clientHeight >= e.scrollHeight - 1)).toBe(true);
  await page.screenshot({
    path: 'docs/screenshots/studio-home-v2/home-all-cards.png',
    fullPage: true,
  });
});
