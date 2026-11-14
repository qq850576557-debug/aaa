import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { isHistorical, plus, projectStatus } from '../src/lib/model';
import { workspaceAgenda } from '../src/lib/agenda';
import { workspaceStats } from '../src/lib/workspace-stats';

async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { path, method, body },
  );
}
const businessDay = '2026-11-11';
async function setup(page: Page) {
  // Browser date is still Nov 10 in Los Angeles; studio date is Nov 11 in Shanghai.
  await page.clock.setFixedTime(new Date('2026-11-10T16:30:00Z'));
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.overview-stats')).toBeVisible();
  const d = fixture();
  d.projects[0].name = '导航测试工地';
  d.projects.push(
    { ...d.projects[0], id: 'nav-b', name: '导航测试工地' },
    { ...d.projects[0], id: 'nav-closed', name: '完工测试工地', status: '已完工' },
    { ...d.projects[0], id: 'nav-paused', name: '暂停测试工地', status: '暂停' },
  );
  d.trades.push(...d.trades.map((t) => ({ ...t, id: 'b-' + t.id, projectId: 'nav-b' })));
  d.tasks = [
    { ...d.tasks[0], name: '甲施工测试', start: businessDay, end: businessDay },
    {
      ...d.tasks[0],
      id: 'b-task',
      projectId: 'nav-b',
      tradeId: d.trades.find((t) => t.projectId === 'nav-b')!.id,
      name: '乙施工测试',
      start: businessDay,
      end: businessDay,
    },
  ];
  d.notes = [
    {
      ...d.notes[0],
      title: '历史来源测试提醒',
      date: plus(businessDay, -1),
      reminder: '',
      pinned: true,
    },
  ];
  d.purchases = ['p-home', 'nav-b', 'nav-closed', 'nav-paused'].map((projectId, i) => ({
    ...d.purchases[0],
    id: 'buy-' + i,
    projectId,
    taskId: '',
    name: '测试材料' + i,
    due: businessDay,
    status: i === 1 ? '已下单' : '待采购',
  }));
  await api(page, '/workspace', 'PUT', { revision: 0, data: d });
  for (const [projectId, title, nodeDate, status] of [
    ['p-home', '甲测试事项', businessDay, '持续跟进'],
    ['nav-b', '乙逾期测试事项', plus(businessDay, -1), '持续跟进'],
    ['nav-b', '乙明日测试事项', plus(businessDay, 1), '持续跟进'],
    ['p-home', '甲明日完成测试', plus(businessDay, 1), '已完成'],
    ['nav-closed', '完工测试事项', businessDay, '持续跟进'],
    ['nav-paused', '暂停测试事项', businessDay, '持续跟进'],
  ])
    await api(page, '/records', 'POST', {
      requestId: crypto.randomUUID(),
      value: { projectId, title, nodeDate, status, notes: '', followUp: '', owner: '' },
    });
  await page.reload();
  await expect(page.getByTestId('today-panel')).toBeVisible();
  return {
    d: (await api(page)).data as typeof d,
    records: (await api(page, '/records')).records,
    f,
  };
}
async function choose(page: Page, id: string) {
  await page.locator(`.project-card[data-project-id="${id}"] .project-select`).click();
  await expectDetail(page, id);
  await expect(page.locator('.project-card.chosen')).toHaveCount(1);
  await expect(page.locator(`.project-card[data-project-id="${id}"]`)).toHaveClass(/chosen/);
  await expect(page.locator('#project-timeline')).toBeVisible();
}
async function expectDetail(page: Page, id: string) {
  await expect(page.locator('.app-shell')).toHaveAttribute('data-view', 'project-detail');
  await expect(page.getByRole('button', { name: '项目工作空间', exact: true })).not.toHaveClass(
    /active/,
  );
  await expect(page.locator('.sidebar nav button.active')).toHaveCount(0);
  await expect(page.locator('.sidebar nav [aria-current="page"]')).toHaveCount(0);
  await expect(page.locator('.project-card.chosen')).toHaveAttribute('data-project-id', id);
}
async function expectOverview(page: Page) {
  await expect(page.locator('.app-shell')).toHaveAttribute('data-view', 'overview');
  await expect(page.getByRole('button', { name: '项目工作空间', exact: true })).toHaveClass(
    /active/,
  );
  await expect(page.getByRole('button', { name: '项目工作空间', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
}
async function expand(page: Page) {
  for (const id of ['today-panel', 'tomorrow-panel']) {
    const button = page.getByTestId(id).locator('.brief-toggle');
    if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
  }
}
test.use({ timezoneId: 'America/Los_Angeles' });
for (const width of [1280, 1440, 1920])
  test(`all-site default and scoped project layout ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { d, records } = await setup(page);
    await expectOverview(page);
    await expect(page.locator('.project-card.chosen')).toHaveCount(0);
    await expect(page.locator('#project-timeline, .project-toolbar')).toHaveCount(0);
    await expect(page.locator('.sidebar > .sidebar-section')).toHaveCount(0);
    await expect(page.locator('.page-heading h1')).toHaveText('项目工作空间');
    await expect(page.locator('.page-heading p, .page-heading .compact-stats')).toHaveCount(0);
    const cards = page.locator('.overview-stats .overview-stat');
    await expect(cards).toHaveCount(5);
    const count = workspaceStats(d, records, businessDay);
    for (const [label, value] of [
      ['项目总数', count.total],
      ['施工中的项目', count.ongoing],
      ['今日待办', count.todos],
      ['未来 15 天采购', count.upcoming],
      ['已逾期采购', count.overduePurchases],
    ])
      await expect(
        page
          .getByRole('group', { name: '全部工地统计' })
          .getByRole('button', { name: `${label}：${value}`, exact: true }),
      ).toBeVisible();
    const rects = await cards.evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { y: r.y, height: r.height };
      }),
    );
    expect(new Set(rects.map((r) => r.y)).size).toBe(1);
    expect(rects.every((r) => r.height >= 64 && r.height <= 90)).toBe(true);
    const shortcuts = page.locator('.ongoing-project-card');
    const ongoing = d.projects.filter(
      (p) => !isHistorical(p) && projectStatus(p.status) === '施工中',
    );
    await expect(shortcuts).toHaveCount(ongoing.length);
    expect(
      await shortcuts.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-project-id')),
      ),
    ).toEqual(ongoing.map((p) => p.id));
    for (const project of ongoing) {
      const shortcut = page.locator(`.ongoing-project-card[data-project-id="${project.id}"]`);
      const sidebar = page.locator(`.project-card[data-project-id="${project.id}"]`);
      expect(await shortcut.getAttribute('data-project-hue')).toBe(
        await sidebar.getAttribute('data-project-hue'),
      );
      await expect(shortcut.locator('button')).toHaveCount(1);
      await expect(shortcut).toContainText(project.name);
      await expect(shortcut).toContainText('施工中');
      expect(await shortcut.locator('.ongoing-project-progress > :last-child').textContent()).toBe(
        await sidebar.locator('.project-select > small').first().textContent(),
      );
    }
    const statsBox = await page.locator('.overview-stats').boundingBox();
    const sitesBox = await page.locator('.ongoing-projects').boundingBox();
    // The confirmed V2 home opens all reminders by default (no four-item truncation).
    await expect(page.getByTestId('today-panel').locator('.agenda-item')).toHaveCount(
      workspaceAgenda(d, records, undefined, businessDay).today.length,
    );
    const todayBox = await page.getByTestId('today-panel').boundingBox();
    const tomorrowBox = await page.getByTestId('tomorrow-panel').boundingBox();
    expect(sitesBox!.y).toBeGreaterThan(statsBox!.y + statsBox!.height);
    expect(todayBox!.y).toBeGreaterThan(sitesBox!.y + sitesBox!.height);
    const studioBox = await page.locator('.sd-section').boundingBox();
    expect(studioBox!.y).toBeGreaterThan(sitesBox!.y + sitesBox!.height);
    expect(todayBox!.y).toBeGreaterThan(studioBox!.y + studioBox!.height);
    expect(Math.abs(todayBox!.y - tomorrowBox!.y)).toBeLessThan(1);
    expect(Math.abs(todayBox!.height - tomorrowBox!.height)).toBeLessThan(1);
    expect(todayBox!.height).toBeGreaterThanOrEqual(354);
    const firstTile = page.getByTestId('today-panel').locator('.agenda-item').first();
    const tileBox = await firstTile.boundingBox();
    expect(tileBox!.width).toBeGreaterThanOrEqual(200);
    expect(tileBox!.width).toBeLessThanOrEqual(340);
    expect(
      await firstTile.locator('strong').evaluate((node) => getComputedStyle(node).fontSize),
    ).toBe('15px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/chunmo-overview-home-${width}.png`, fullPage: true });
    await expect(page.getByTestId('today-panel').locator('time').first()).toHaveText(businessDay);
    await expand(page);
    const agenda = workspaceAgenda(d, records, undefined, businessDay);
    for (const [panel, items] of [
      ['today-panel', agenda.today],
      ['tomorrow-panel', agenda.tomorrow],
    ] as const) {
      await expect(page.getByTestId(panel).locator('.agenda-item strong')).toHaveText(
        items.map((i) => i.title),
      );
      const rendered = await page
        .getByTestId(panel)
        .locator('.agenda-item')
        .evaluateAll((nodes) =>
          nodes.map((n) => [
            n.getAttribute('data-agenda-kind'),
            n.getAttribute('data-agenda-id'),
            n.getAttribute('data-agenda-project'),
          ]),
        );
      expect(rendered).toEqual(items.map((i) => [i.kind, i.id, i.projectId]));
      for (const node of await page.getByTestId(panel).locator('.agenda-item').all())
        await expect(node.locator('.agenda-item-meta')).toContainText('导航测试工地');
    }
    await expect(page.locator('.agenda-item')).not.toContainText(['完工测试事项', '暂停测试事项']);
    await page.screenshot({ path: `/tmp/chunmo-overview-all-${width}.png`, fullPage: true });
    await page.locator('.ongoing-project-card[data-project-id="nav-b"] button').click();
    await expectDetail(page, 'nav-b');
    await expect(page.locator('.ongoing-projects')).toHaveCount(0);
    await expect(page.locator('.overview-stats')).toHaveCount(0);
    await expect(page.locator('.page-heading .compact-stat')).toHaveCount(5);
    await expect(
      page
        .getByRole('group', { name: '当前工地统计' })
        .getByRole('button', { name: '项目总数：1', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.task-details-list')).toContainText('乙施工测试');
    await expect(page.locator('.date-cell.today')).toHaveAttribute(
      'aria-label',
      `查看 ${businessDay} 事项`,
    );
    await expect(page.locator('.task-details-list')).not.toContainText('甲施工测试');
    await expect(page.locator('.agenda-item[data-agenda-project="p-home"]')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/chunmo-overview-site-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await expect(page.locator('.overview-stats')).toBeVisible();
    await expectOverview(page);
    expect((await api(page)).data).toEqual(d);
    expect((await api(page, '/records')).records).toEqual(records);
  });

test('every main page uses ID navigation; history, scroll, direct links and missing project remain safe', async ({
  page,
}) => {
  const { d, records } = await setup(page);
  for (const name of ['事项管理', '采购管理', '提醒中心', '人员管理', '项目工作空间']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.project-card.chosen')).toHaveCount(0);
    await choose(page, 'nav-b');
    await expect(page).toHaveURL(/project=nav-b/);
  }
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await choose(page, 'p-home');
  await page.evaluate(() => window.scrollTo(0, 350));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(350);
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await choose(page, 'nav-b');
  await page.goBack();
  await expect(page.locator('.daily-records, .record-board').first()).toBeVisible();
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.project-card.chosen')).toHaveAttribute('data-project-id', 'p-home');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(350);
  await page.goBack();
  await expect(page.locator('.overview-stats')).toBeVisible();
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('.project-card.chosen')).toHaveAttribute('data-project-id', 'p-home');
  await page.goForward();
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('.project-card.chosen')).toHaveAttribute('data-project-id', 'nav-b');
  await expectDetail(page, 'nav-b');
  await page.goto('/?project=nav-b');
  await expectDetail(page, 'nav-b');
  await expect(page.locator('.project-card.chosen')).toHaveAttribute('data-project-id', 'nav-b');
  await page.reload();
  await expectDetail(page, 'nav-b');
  await page.goto('/?view=project-detail&project=nav-b');
  await expectDetail(page, 'nav-b');
  await page.goto('/?project=missing-test-site');
  await expect(page.locator('.overview-stats')).toBeVisible();
  await expect(page).not.toHaveURL(/missing-test-site/);
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  expect((await api(page)).data).toEqual(d);
  expect((await api(page, '/records')).records).toEqual(records);
});

test('ongoing shortcuts follow shared project updates, support keyboard navigation and handle an empty overview', async ({
  page,
}) => {
  await setup(page);
  const state = await api(page);
  const added = { ...state.data.projects[0], id: 'nav-new', name: '新增入口测试工地' };
  const next = {
    ...state.data,
    projects: [
      ...state.data.projects,
      added,
      ...Array.from({ length: 6 }, (_, index) => ({
        ...added,
        id: 'nav-extra-' + index,
        name: '换行布局测试工地' + index,
      })),
      { ...added, id: 'nav-archived', name: '归档测试工地', archived: true },
    ],
  };
  await api(page, '/workspace', 'PUT', { revision: state.revision, data: next });
  await expect(page.locator('.ongoing-project-card')).toHaveCount(9);
  const bounds = await page.locator('.ongoing-project-card').evaluateAll((nodes) =>
    nodes.map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  expect(new Set(bounds.map((box) => box.y)).size).toBeGreaterThan(1);
  expect(bounds.every((box) => box.width >= 220 && box.width <= 340)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.ongoing-project-card[data-project-id="nav-archived"]')).toHaveCount(
    0,
  );
  const link = page.locator('.ongoing-project-card[data-project-id="nav-new"] button');
  await link.focus();
  await page.keyboard.press('Enter');
  await expectDetail(page, 'nav-new');
  await page.goBack();
  await expectOverview(page);
  await expect(link).toBeVisible();
  const latest = await api(page);
  await api(page, '/workspace', 'PUT', {
    revision: latest.revision,
    data: {
      ...latest.data,
      projects: latest.data.projects.map((project: any) =>
        !isHistorical(project) ? { ...project, status: '暂停' } : project,
      ),
    },
  });
  await expect(page.locator('.ongoing-project-empty')).toHaveText('暂无在施工工地');
  await expect(page.locator('.ongoing-project-card')).toHaveCount(0);
  await expect(page.locator('.agenda-item')).toHaveCount(0);
  await expect(page.getByTestId('today-panel')).toContainText('今日暂无待办事项');
  await expect(page.getByTestId('tomorrow-panel')).toContainText('明日暂无安排');
  const today = await page.getByTestId('today-panel').boundingBox();
  const tomorrow = await page.getByTestId('tomorrow-panel').boundingBox();
  expect(today!.height).toBeLessThan(400);
  expect(Math.abs(today!.height - tomorrow!.height)).toBeLessThan(1);
  expect((await api(page, '/records')).records).toHaveLength(6);
});

test('browser navigation respects an unsubmitted record draft and preserves saved business data', async ({
  page,
}) => {
  const { records } = await setup(page);
  await choose(page, 'nav-b');
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page
    .locator('.board-tool-primary')
    .getByRole('button', { name: '新增记录', exact: true })
    .click();
  await page.getByLabel('任务事项', { exact: true }).fill('不应丢失的导航草稿');
  await expect(page.locator('.record-drawer')).toContainText('本地');
  await page.evaluate(() => history.back());
  const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(/view=records/);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('任务事项', { exact: true })).toHaveValue('不应丢失的导航草稿');
  await page.evaluate(() => history.back());
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(/view=records/);
  await confirm.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(page.locator('#project-timeline')).toBeVisible();
  await expect(page.locator('.project-card.chosen')).toHaveAttribute('data-project-id', 'nav-b');
  expect((await api(page, '/records')).records).toEqual(records);
});

test('overview actions edit their actual record without selecting a site or duplicating any source', async ({
  page,
}) => {
  const { records } = await setup(page);
  await expand(page);
  await page.getByRole('button', { name: '打开事项：历史来源测试提醒', exact: true }).click();
  const legacy = page.getByRole('dialog', { name: '编辑每日事项', exact: true });
  await legacy.getByLabel('详细备注（可选）', { exact: true }).fill('总览保留历史来源编辑');
  await legacy.getByRole('button', { name: '保存', exact: true }).click();
  await expect(legacy).toHaveCount(0);
  await expect
    .poll(async () => (await api(page)).data.notes[0].content)
    .toBe('总览保留历史来源编辑');
  await page.getByRole('button', { name: '完成甲测试事项', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await api(page, '/records')).records.find((r: any) => r.title === '甲测试事项')?.status,
    )
    .toBe('已完成');
  await expect(page.locator('.overview-stats')).toBeVisible();
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  await page.getByRole('button', { name: '打开采购：测试材料1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
  await expect(dialog.getByLabel('所属项目', { exact: true })).toHaveValue('nav-b');
  await dialog.getByLabel('采购状态', { exact: true }).selectOption('已到货');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await api(page)).data.purchases.find((p: any) => p.id === 'buy-1')?.status)
    .toBe('已到货');
  await expect(page.locator('.overview-stats')).toBeVisible();
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  expect((await api(page, '/records')).records).toHaveLength(records.length);
  await page.reload();
  await expect(page.locator('.overview-stats')).toBeVisible();
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
  await page.getByRole('button', { name: '添加今日事项', exact: true }).click();
  const entry = page.getByRole('dialog');
  await entry.getByRole('radio', { name: '事项管理', exact: true }).check();
  await expect(entry.getByLabel('记录所属项目', { exact: true })).toHaveValue('');
  await entry.getByLabel('记录所属项目', { exact: true }).selectOption('nav-b');
  await entry.getByLabel('任务事项', { exact: true }).fill('总览新增测试事项');
  await expect(entry.getByLabel('记录节点日期', { exact: true })).toHaveValue(businessDay);
  await entry.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await expect
    .poll(async () => (await api(page, '/records')).records.length)
    .toBe(records.length + 1);
  await expect(page.locator('.project-card.chosen')).toHaveCount(0);
});
