import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { plus, stats, today, purchaseStatuses, type Purchase } from '../src/lib/model';

async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const response = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET'
            ? {}
            : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { path, method, body },
  );
}

async function setup(page: Page) {
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const data = fixture();
  data.notes = [];
  data.purchases = [
    ['today', '今日材料', today(), '待采购'],
    ['tomorrow', '明日材料', plus(today(), 1), '已下单'],
    ['overdue', '逾期材料', plus(today(), -1), '待采购'],
    ['arrived', '到货材料', today(), '已到货'],
    ['completed', '完成材料', today(), '已完成'],
  ].map(([id, name, due, status]) => ({
    ...data.purchases[0],
    id,
    name,
    due,
    taskId: '',
    status: status as Purchase['status'],
  }));
  await api(page, '/workspace', 'PUT', { revision: 0, data });
  await page.reload();
  await page.locator('.project-card[data-project-id="p-home"] .project-select').click();
  await expect(page.locator('.compact-stats')).toBeVisible();
  return data;
}

for (const width of [1280, 1440]) {
  test(`compact live metrics and timeline legend do not overlap actions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = await setup(page);
    const expected = stats(data);
    const heading = page.locator('.compact-page-heading');
    await expect(heading.locator('p')).toHaveCount(0);
    await expect(page.locator('.stats-grid')).toBeHidden();
    const labels = ['项目总数', '施工中的项目', '今日待办', '未来 15 天采购', '已逾期采购'];
    const values = [
      expected.total,
      expected.ongoing,
      expected.todos,
      expected.upcoming,
      expected.overduePurchases,
    ];
    for (let i = 0; i < labels.length; i++)
      await expect(
        heading.getByRole('button', { name: `${labels[i]}：${values[i]}`, exact: true }),
      ).toBeVisible();
    await expect(heading.getByRole('button', { name: '新建项目', exact: true })).toBeVisible();
    await expect(heading.getByRole('button', { name: '历史版本', exact: true })).toBeVisible();
    const title = (await heading.locator('h1').boundingBox())!;
    const metrics = (await heading.locator('.compact-stats').boundingBox())!;
    expect(metrics.y).toBeLessThan(title.y + title.height);
    expect(metrics.x).toBeGreaterThan(title.x + title.width);
    const left = (await heading.locator(':scope > div').first().boundingBox())!;
    const right = (await heading.locator('.heading-actions').boundingBox())!;
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    const timeline = page.locator('#project-timeline');
    await expect(
      timeline.locator('.section-heading p, .today-construction, h2 .count'),
    ).toHaveCount(0);
    const legend = timeline.getByRole('group', { name: '施工工种颜色', exact: true });
    await expect(legend.getByRole('button')).toHaveCount(data.trades.length);
    // Tasks outside the visible date window are virtualized, not removed.
    await expect(timeline.locator('.task-bar').first()).toBeVisible();
    const legendBounds = (await legend.boundingBox())!;
    const toolsBounds = (await timeline.locator('.toolbar').boundingBox())!;
    const overlap =
      Math.min(legendBounds.x + legendBounds.width, toolsBounds.x + toolsBounds.width) >
        Math.max(legendBounds.x, toolsBounds.x) &&
      Math.min(legendBounds.y + legendBounds.height, toolsBounds.y + toolsBounds.height) >
        Math.max(legendBounds.y, toolsBounds.y);
    expect(overlap).toBe(false);
    const before = (await api(page)).data;
    await legend.getByRole('button').first().click();
    await expect(
      page.getByRole('dialog', { name: `${data.trades[0].name} · 工种颜色`, exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await api(page)).data).toEqual(before);
    await page.screenshot({ path: `/tmp/chunmo-compact-workspace-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await expect(heading.locator('h1')).toHaveText('材料采购管理');
    await expect(heading.locator('p')).toHaveCount(0);
    await expect(page.locator('.stats-grid')).toBeHidden();
    await expect(heading.locator('.compact-stat')).toHaveCount(5);
    await expect(page.getByRole('button', { name: '新增采购', exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/chunmo-compact-purchases-${width}.png`, fullPage: true });
  });
}

test('four purchase states persist through quick edits and editor, update reminders/metrics, and keep mounted UI stable', async ({
  page,
}) => {
  const data = await setup(page);
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  const card = page.locator('[data-purchase-id="today"]');
  const quick = card.getByRole('combobox', { name: '采购状态今日材料', exact: true });
  await expect(quick.locator('option')).toHaveText([...purchaseStatuses]);
  await card.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await card.evaluate((node) => {
    (node as HTMLElement).dataset.mountTest = 'original';
  });
  const states: Purchase['status'][] = ['已下单', '已到货', '已完成', '待采购'];
  for (const state of states) {
    await quick.selectOption(state);
    await expect(card).toHaveAttribute('data-purchase-status', state);
    await expect
      .poll(
        async () => (await api(page)).data.purchases.find((p: Purchase) => p.id === 'today').status,
      )
      .toBe(state);
    await expect(card).toHaveAttribute('data-mount-test', 'original');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(page.locator('.loading')).toHaveCount(0);
    const upcoming = state === '已完成' || state === '已到货' ? 1 : 2;
    await expect(
      page
        .locator('.compact-stats')
        .getByRole('button', { name: `未来 15 天采购：${upcoming}`, exact: true }),
    ).toBeVisible();
    if (state === '已完成')
      expect(await card.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
        'rgb(240, 242, 239)',
      );
  }
  await card.getByRole('button', { name: '编辑采购今日材料', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
  const editor = modal.getByLabel('采购状态', { exact: true });
  await expect(editor.locator('option')).toHaveText([...purchaseStatuses]);
  await editor.selectOption('已到货');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(quick).toHaveValue('已到货');
  await expect(card).toContainText('采购已到货');
  await expect
    .poll(
      async () => (await api(page)).data.purchases.find((p: Purchase) => p.id === 'today').status,
    )
    .toBe('已到货');
  await page.reload();
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await expect(quick).toHaveValue('已到货');
  const saved = (await api(page)).data;
  expect(
    saved.projects.map(
      ({ updatedAt: _time, ...project }: (typeof data.projects)[number]) => project,
    ),
  ).toEqual(data.projects.map(({ updatedAt: _time, ...project }) => project));
  expect(saved.tasks).toEqual(data.tasks);
  expect(saved.purchases).toHaveLength(data.purchases.length);
  await page.getByRole('button', { name: '提醒中心', exact: true }).click();
  await expect(page.locator('.reminder-purchases [data-purchase-id="today"]')).toHaveCount(0);
  await expect(page.locator('.reminder-purchases [data-purchase-id="overdue"]')).toBeVisible();
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  const todayPanel = page.getByTestId('today-panel');
  await todayPanel.getByRole('button', { name: '展开今日事项', exact: true }).click();
  const arrived = todayPanel
    .locator('.agenda-item[data-purchase-status="已到货"]')
    .filter({ hasText: '今日材料' });
  await expect(arrived).toBeVisible();
  expect(
    await arrived
      .locator('.agenda-complete')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(227, 239, 229)');
  const completed = todayPanel.locator('.agenda-item[data-purchase-status="已完成"]');
  expect(
    await completed
      .locator('.agenda-complete')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(233, 236, 233)');
  await page.goto('/?mobile=1');
  await page
    .getByRole('navigation', { name: '手机主要入口' })
    .getByRole('button', { name: '采购', exact: true })
    .click();
  const mobile = page.locator('.mobile-work-row').filter({ hasText: '今日材料' });
  await expect(mobile.locator('select option')).toHaveText([...purchaseStatuses]);
  await expect(mobile.locator('select')).toHaveValue('已到货');
});
