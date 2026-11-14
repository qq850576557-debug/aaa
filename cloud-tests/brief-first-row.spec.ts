import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { plus } from '../src/lib/model';

async function setup(page: Page, todayCount = 12, tomorrowCount = 12) {
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const data = fixture();
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  data.notes = [];
  data.projects[0].name = '布局测试工地 A';
  data.projects.push({ ...data.projects[0], id: 'row-site-b', name: '布局测试工地 B' });
  data.purchases = Array.from({ length: todayCount + tomorrowCount }, (_, i) => ({
    ...data.purchases[0],
    id: 'row-photo-' + i,
    projectId: i % 2 ? 'row-site-b' : data.projects[0].id,
    name: '测试材料 ' + (i + 1),
    taskId: '',
    deadlineMode: 'fixed' as const,
    due: i < todayCount ? day : plus(day, 1),
    originalDue: undefined,
    approvedDue: undefined,
    status: i % 3 ? ('待采购' as const) : ('已完成' as const),
  }));
  const status = await page.evaluate(async (data) => {
    const s = await (await fetch('/api/auth/session')).json();
    return (
      await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        body: JSON.stringify({ revision: 0, data }),
      })
    ).status;
  }, data);
  expect(status).toBe(200);
  await page.reload();
  await expect(page.getByTestId('today-panel').locator('.agenda-item')).toHaveCount(todayCount);
  await expect(page.getByTestId('tomorrow-panel').locator('.agenda-item')).toHaveCount(
    tomorrowCount,
  );
}

async function assertFirstRow(page: Page, id: string, total = 12) {
  const panel = page.getByTestId(id),
    content = panel.locator('.brief-content');
  const visible = panel.locator('.agenda-item:visible');
  // Independent CSS track count assertion; production uses actual card row positions.
  await expect
    .poll(async () => {
      const columns = await content.evaluate(
        (e) => getComputedStyle(e).gridTemplateColumns.trim().split(/\s+/).length,
      );
      return (await visible.count()) === Math.min(columns, total);
    })
    .toBe(true);
  const rects = await visible.evaluateAll((ns) =>
    ns.map((n) => {
      const r = n.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }),
  );
  expect(rects.length).toBeGreaterThan(0);
  expect(Math.max(...rects.map((r) => r.top)) - Math.min(...rects.map((r) => r.top))).toBeLessThan(
    1,
  );
  const box = (await content.boundingBox())!;
  expect(Math.abs(box.y + box.height - Math.max(...rects.map((r) => r.bottom)))).toBeLessThan(2);
  await expect(panel.locator('.count')).toHaveText(String(total));
  expect(await panel.locator('.agenda-item').count()).toBe(total);
  expect(await panel.evaluate((e) => getComputedStyle(e).minHeight)).toBe('0px');
}

for (const width of [1280, 1440, 1920])
  test(`desktop first row remains complete and resizes at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const today = page.getByTestId('today-panel'),
      tomorrow = page.getByTestId('tomorrow-panel');
    await expect(today.locator('.agenda-item:visible')).toHaveCount(12);
    await expect(tomorrow.locator('.agenda-item:visible')).toHaveCount(12);
    const allIds = await today
      .locator('.agenda-item')
      .evaluateAll((ns) => ns.map((n) => n.getAttribute('data-agenda-id')));
    const originalTheme = await today
      .locator('.agenda-item')
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    const expandedHeight = (await today.boundingBox())!.height;
    const dir = 'docs/screenshots/brief-first-row';
    await mkdir(dir, { recursive: true });
    await page.screenshot({ fullPage: true, path: `${dir}/expanded-${width}.png` });
    await today.getByRole('button', { name: '收起今日事项', exact: true }).click();
    await assertFirstRow(page, 'today-panel');
    await expect(tomorrow.locator('.agenda-item:visible')).toHaveCount(12);
    expect((await today.boundingBox())!.height).toBeLessThan(expandedHeight);
    expect(
      await today
        .locator('.agenda-item')
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    ).toBe(originalTheme);
    expect(
      await today
        .locator('.agenda-item')
        .evaluateAll((ns) => ns.map((n) => n.getAttribute('data-agenda-id'))),
    ).toEqual(allIds);
    await tomorrow.getByRole('button', { name: '收起明日提醒', exact: true }).click();
    await assertFirstRow(page, 'tomorrow-panel');
    await page.screenshot({ fullPage: true, path: `${dir}/collapsed-${width}.png` });
    // Resize without expanding: hidden cards must be remeasured and restored as needed.
    for (const resized of [
      1920,
      1280,
      ...(width === 1440 ? [1600, 1610, 1620, 1630, 1640] : []),
      width,
    ]) {
      await page.setViewportSize({ width: resized, height: 1300 });
      await assertFirstRow(page, 'today-panel');
      await assertFirstRow(page, 'tomorrow-panel');
    }
    await tomorrow.getByRole('button', { name: '展开明日提醒', exact: true }).click();
    await expect(tomorrow.locator('.agenda-item:visible')).toHaveCount(12);
    await assertFirstRow(page, 'today-panel');
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await assertFirstRow(page, 'today-panel');
    await expect(tomorrow.locator('.agenda-item:visible')).toHaveCount(12);
    // Visible cards retain their original editing handler.
    await today.locator('.agenda-item:visible .agenda-item-main').first().click();
    await expect(page.getByRole('dialog', { name: '编辑采购事项', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    await page.reload();
    await expect(today.locator('.agenda-item:visible')).toHaveCount(12);
    await expect(tomorrow.locator('.agenda-item:visible')).toHaveCount(12);
  });

test('empty and single-item panels keep their content and have no reserved collapsed height', async ({
  page,
}) => {
  await setup(page, 0, 1);
  await page.getByRole('button', { name: '收起今日事项', exact: true }).click();
  await page.getByRole('button', { name: '收起明日提醒', exact: true }).click();
  await expect(page.getByTestId('today-panel')).toContainText('今日暂无待办事项');
  await expect(page.getByTestId('today-panel').locator('.count')).toHaveText('0');
  const emptyHeight = (await page.getByTestId('today-panel').boundingBox())!.height;
  const singleHeight = (await page.getByTestId('tomorrow-panel').boundingBox())!.height;
  expect(emptyHeight).toBeLessThan(380);
  expect(Math.abs(emptyHeight - singleHeight)).toBeLessThanOrEqual(2);
  await assertFirstRow(page, 'tomorrow-panel', 1);
});
