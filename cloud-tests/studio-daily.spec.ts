import { test, expect } from '@playwright/test';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { mkdir } from 'node:fs/promises';
test.afterAll(async () => {
  await pool.end();
  await privatePool.end();
});
test('desktop founder manages simple requirements and rotation; staff can only read their content', async ({
  page,
  browser,
}) => {
  const f = await fixtureAccounts(2);
  await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', [
    '测试员工 A',
    f.employeeId,
  ]);
  await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', [
    '测试员工 B',
    f.employees[1].id,
  ]);
  await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', ['测试创始人', f.id]);
  async function signIn(p: typeof page, login: string) {
    await p.goto('/');
    await p.getByLabel('登录账号', { exact: true }).fill(login);
    await p.getByLabel('登录密码', { exact: true }).fill(f.password);
    await p.getByRole('button', { name: '登录', exact: true }).click();
    await expect(p.locator('.save-state')).toContainText('已保存');
  }
  await signIn(page, f.login);
  const dir = 'docs/screenshots/studio-home-v3';
  await mkdir(dir, { recursive: true });
  await page.getByRole('button', { name: '收起今日事项', exact: true }).click();
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开今日事项', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '收起今日事项', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理每日必做', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '每日必做', exact: true });
  await modal
    .getByLabel('工作要求', { exact: true })
    .fill('工作结束前检查门窗、电源，保持现场整洁。');
  await modal.getByLabel('测试员工 A', { exact: true }).check();
  await expect(modal.getByText('周一', { exact: true })).toHaveCount(0);
  await modal.screenshot({ path: dir + '/rules-manager.png' });
  // Closing and reopening keeps the in-memory draft.
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '管理每日必做', exact: true }).click();
  await expect(modal.getByLabel('工作要求', { exact: true })).toHaveValue(
    '工作结束前检查门窗、电源，保持现场整洁。',
  );
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('studio-rules')).toContainText('检查门窗');
  await page.getByRole('button', { name: '管理每日必做', exact: true }).click();
  await modal
    .getByLabel('工作要求', { exact: true })
    .fill('每天下班前整理工作台，妥善归档当日资料。');
  await expect(modal.getByRole('button', { name: '全体员工', exact: true })).toBeVisible();
  await modal.screenshot({ path: dir + '/rules-manager.png' });
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '编辑值日', exact: true }).click();
  modal = page.getByRole('dialog', { name: '编辑值日', exact: true });
  await modal.getByLabel('测试员工 A', { exact: true }).check();
  await modal.getByLabel('测试员工 B', { exact: true }).check();
  await modal.getByLabel('轮换周期', { exact: true }).selectOption('3');
  await modal.getByLabel('起始日期', { exact: true }).fill('2026-11-16');
  await expect(modal.locator('.sd-preview')).toContainText('2026-11-19');
  await modal.screenshot({ path: dir + '/duty-manager.png' });
  await modal.getByRole('button', { name: '确认预览并保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.sd-duty')).toContainText('每3天轮换');
  await page.getByRole('button', { name: '编辑值日', exact: true }).click();
  await modal.getByLabel('本次操作', { exact: true }).selectOption('complete');
  await modal.getByLabel('实际完成日期', { exact: true }).fill('2026-11-15');
  await expect(modal.locator('.sd-preview')).toContainText('2026-11-18');
  await modal.getByRole('button', { name: '确认预览并保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.screenshot({ path: dir + '/home.png', fullPage: true });
  await page.getByRole('button', { name: '查看排班', exact: true }).click();
  const schedule = page.getByRole('dialog', { name: '值日排班', exact: true });
  await expect(schedule).toContainText('2026-11-15 · 已完成');
  await schedule.screenshot({ path: dir + '/schedule.png' });
  await page.keyboard.press('Escape');
  await expect(schedule).toHaveCount(0);
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const staff = await context.newPage();
  await signIn(staff, f.employee);
  await expect(staff.getByTestId('studio-rules')).toContainText('检查门窗');
  await expect(staff.getByRole('button', { name: '管理每日必做', exact: true })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: '编辑值日', exact: true })).toHaveCount(0);
  await staff.getByRole('button', { name: '查看排班', exact: true }).click();
  await expect(staff.getByRole('dialog', { name: '值日排班', exact: true })).toBeVisible();
  await staff.screenshot({ path: dir + '/staff-readonly.png', fullPage: true });
  await context.close();
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const other = await otherContext.newPage();
  await signIn(other, f.employees[1].login);
  await expect(other.getByTestId('studio-rules')).not.toContainText('检查门窗');
  await expect(other.getByTestId('studio-rules')).toContainText('整理工作台');
  await otherContext.close();
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
    path: 'docs/screenshots/studio-home-v3/home-all-cards.png',
    fullPage: true,
  });
});
