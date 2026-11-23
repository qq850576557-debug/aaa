import { test, expect } from '@playwright/test';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { studioDay, studioWeek } from '../src/lib/studio-daily';
import { plus } from '../src/lib/model';
test.afterAll(async () => {
  await pool.end();
  await privatePool.end();
});
test('desktop founder manages simple requirements and rotation; staff can only read their content', async ({
  page,
  browser,
}) => {
  const f = await fixtureAccounts(2);
  const day = studioDay(),
    completed = plus(day, -1);
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
  const dir = test.info().outputDir;
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
  await modal.getByLabel('起始日期', { exact: true }).fill(day);
  await expect(modal.locator('.sd-preview')).toContainText(plus(day, 3));
  await modal.screenshot({ path: dir + '/duty-manager.png' });
  await modal.getByRole('button', { name: '确认预览并保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.sd-duty')).toContainText('每3天轮换');
  await page.getByRole('button', { name: '编辑值日', exact: true }).click();
  await modal.getByLabel('本次操作', { exact: true }).selectOption('complete');
  await modal.getByLabel('实际完成日期', { exact: true }).fill(completed);
  await expect(modal.locator('.sd-preview')).toContainText(plus(day, 3));
  await modal.getByLabel('按实际完成日期重新安排后续排班').check();
  await expect(modal.locator('.sd-preview')).toContainText(plus(completed, 3));
  await modal.screenshot({ path: dir + '/completion.png' });
  await modal.getByRole('button', { name: '确认预览并保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.screenshot({ path: dir + '/home.png', fullPage: true });
  await page.getByRole('button', { name: '查看排班', exact: true }).click();
  const schedule = page.getByRole('dialog', { name: '值日排班', exact: true });
  if (completed < studioWeek(day)[0])
    await schedule.getByRole('button', { name: '上周', exact: true }).click();
  await expect(schedule).toContainText(completed + ' · 已完成');
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

  await page.setViewportSize({ width: 1024, height: 760 });
  await page.goto('/?ui=legacy');
  await page.getByRole('button', { name: '编辑值日', exact: true }).click();
  modal = page.getByRole('dialog', { name: '编辑值日', exact: true });
  await modal.getByLabel('本次操作').selectOption('complete');
  const reschedule = modal.getByRole('checkbox', { name: '按实际完成日期重新安排后续排班' });
  await reschedule.focus();
  await page.keyboard.press('Space');
  await expect(reschedule).toBeChecked();
  expect((await reschedule.boundingBox())?.width).toBeLessThanOrEqual(16);
  expect(
    await modal.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    }),
  ).toBe(true);
  await modal.screenshot({ path: dir + '/completion-legacy.png' });
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
    path: test.info().outputPath('home-all-cards.png'),
    fullPage: true,
  });
});

test('Beijing midnight and tab return update all rotation views and keep an unsaved draft', async ({
  page,
}) => {
  const f = await fixtureAccounts(2);
  const people = [f.id, f.employeeId, f.employees[1].id];
  const names = ['模拟员工 A', '模拟员工 B', '模拟员工 C'];
  for (let i = 0; i < people.length; i++)
    await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', [names[i], people[i]]);

  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const status = await page.evaluate(async (people) => {
    const session = await (await fetch('/api/auth/session')).json();
    return (
      await fetch('/api/studio-daily/rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          version: 0,
          value: {
            action: 'configure',
            interval: 7,
            people,
            start: '2026-11-15',
            currentDate: '2026-11-15',
          },
        }),
      })
    ).status;
  }, people);
  expect(status).toBe(200);

  let instant = Date.parse('2026-11-21T23:59:40+08:00');
  await page.clock.install({ time: instant });
  let reads = 0;
  await page.route('**/api/studio-daily', async (route) => {
    const response = await route.fetch();
    reads++;
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        day: studioDay(instant),
        serverTime: instant,
      },
    });
  });
  await page.reload();
  const card = page.locator('.sd-duty');
  await expect(card.locator('.sd-person')).toHaveText(names[0]);
  await expect(card).toContainText('2026-11-15');
  const initialReads = reads;
  instant += 25000;
  await page.clock.fastForward(25000);
  await expect(card.locator('.sd-person')).toHaveText(names[1]);
  await expect(card).toContainText('2026-11-22');
  expect(reads).toBeGreaterThan(initialReads);

  instant = Date.parse('2026-11-23T12:00:00+08:00');
  const showTab = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await showTab();
  await expect.poll(() => reads).toBeGreaterThan(initialReads + 1);
  await expect(card).toContainText('2026-11-29');
  await expect(card).not.toContainText('最近完成');
  await card.screenshot({ path: test.info().outputPath('home-nov23.png') });
  await page.getByRole('button', { name: '查看排班', exact: true }).click();
  const schedule = page.getByRole('dialog', { name: '值日排班', exact: true });
  await expect(schedule.getByLabel('近期三轮值日').getByText(names[1])).toBeVisible();
  await expect(schedule.getByLabel('近期三轮值日')).toContainText('2026-11-29');
  await expect(schedule).not.toContainText('已完成');
  await schedule.screenshot({ path: test.info().outputPath('schedule-nov23.png') });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '编辑值日', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑值日', exact: true });
  await expect(editor.getByLabel('当前轮次计划日期')).toHaveValue('2026-11-22');
  await editor.getByLabel('本次操作').selectOption('complete');
  await expect(editor).toContainText('本轮：模拟员工 B · 计划 2026-11-22');
  await expect(editor.locator('.sd-preview')).toContainText('2026-11-29');
  await editor.getByLabel('按实际完成日期重新安排后续排班').check();
  await expect(editor.locator('.sd-preview')).toContainText('2026-11-30');
  await editor.screenshot({ path: test.info().outputPath('completion-nov23.png') });

  instant = Date.parse('2026-11-29T12:00:00+08:00');
  await showTab();
  await expect(card.locator('.sd-person')).toHaveText(names[2]);
  await expect(editor.getByLabel('实际完成日期', { exact: true })).toHaveValue('2026-11-23');
  await expect(editor.getByLabel('按实际完成日期重新安排后续排班')).toBeChecked();
  await expect(editor).toContainText('本轮：模拟员工 B · 计划 2026-11-22');
});
