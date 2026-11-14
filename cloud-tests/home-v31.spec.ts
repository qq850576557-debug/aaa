import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { emptyStudio, studioDay } from '../src/lib/studio-daily';
import { plus } from '../src/lib/model';

const dir = 'docs/screenshots/home-v31';
test.use({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await r.json();
      if (!r.ok) throw Error('HTTP ' + r.status + ' ' + value.error);
      return value;
    },
    { path, method, body },
  );
}
async function login(page: Page, login: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
async function fullScreenshot(page: Page, path: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path, fullPage: true });
}
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const e = document.querySelector(selector)!;
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const pair = (a: string, b: string, edge: 'top' | 'bottom' = 'top') =>
      Math.abs(rect(a)[edge] - rect(b)[edge]);
    const panels = ['[data-testid=today-panel]', '[data-testid=tomorrow-panel]'];
    const first = panels.map((s) =>
      Array.from(document.querySelectorAll(s + ' .agenda-item'))
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => e.getBoundingClientRect()),
    );
    const row = first.map((rs) => rs.filter((r) => Math.abs(r.top - rs[0]?.top) < 1));
    const allFirst = row.flat();
    return {
      studioTop: pair('.sd-rules', '.sd-duty'),
      studioBottom: pair('.sd-rules', '.sd-duty', 'bottom'),
      studioTitle: pair('.sd-rules h2', '.sd-duty h2'),
      studioFooter: pair('.sd-rules .sd-card-foot', '.sd-duty .sd-card-foot'),
      agendaTop: pair(panels[0], panels[1]),
      agendaBottom: pair(panels[0], panels[1], 'bottom'),
      agendaTitle: pair(panels[0] + ' h2', panels[1] + ' h2'),
      agendaDate: pair(panels[0] + ' .brief-date', panels[1] + ' .brief-date'),
      agendaToggle: pair(panels[0] + ' .brief-toggle', panels[1] + ' .brief-toggle'),
      agendaFooter: pair(panels[0] + ' .brief-actions', panels[1] + ' .brief-actions'),
      firstRowTop: row[0].length && row[1].length ? Math.abs(row[0][0].top - row[1][0].top) : 0,
      firstRowHeight: allFirst.length
        ? Math.max(...allFirst.map((r) => r.height)) - Math.min(...allFirst.map((r) => r.height))
        : 0,
      overflow: document.documentElement.scrollWidth > innerWidth,
      leftHeight: rect(panels[0]).height,
      rightHeight: rect(panels[1]).height,
    };
  });
}
function aligned(result: Awaited<ReturnType<typeof measure>>, sameState: boolean) {
  for (const key of [
    'studioTop',
    'studioBottom',
    'studioTitle',
    'studioFooter',
    'agendaTop',
    'agendaTitle',
    'agendaDate',
    'agendaToggle',
    'firstRowTop',
    'firstRowHeight',
  ] as const)
    expect(result[key], key).toBeLessThanOrEqual(2);
  if (sameState) {
    expect(result.agendaBottom, 'agendaBottom').toBeLessThanOrEqual(2);
    expect(result.agendaFooter, 'agendaFooter').toBeLessThanOrEqual(2);
  }
  expect(result.overflow).toBe(false);
}
async function modalFits(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const result = await dialog.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return {
      top: r.top,
      left: r.left,
      bottom: r.bottom,
      right: r.right,
      height: innerHeight,
      width: innerWidth,
      overflow: e.scrollWidth > e.clientWidth,
    };
  });
  expect(result.top).toBeGreaterThanOrEqual(0);
  expect(result.left).toBeGreaterThanOrEqual(0);
  expect(result.bottom).toBeLessThanOrEqual(result.height);
  expect(result.right).toBeLessThanOrEqual(result.width);
  expect(result.overflow).toBe(false);
}

for (const width of [1280, 1440, 1920, 2560])
  test(`home V3.1 geometric and real-save acceptance ${width}`, async ({ page, browser }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts(2);
    for (const [id, name] of [
      [f.id, '测试创始人'],
      [f.employeeId, '测试员工甲'],
      [f.employees[1].id, '测试员工乙'],
    ])
      await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', [name, id]);
    await login(page, f.login, f.password);
    await mkdir(dir, { recursive: true });
    const day = studioDay(),
      base = fixture();
    base.projects[0].name = '布局验收工地甲';
    base.projects.push({ ...base.projects[0], id: 'geometry-b', name: '布局验收工地乙' });
    const records = [];
    for (const [index, scenario] of [
      { today: 8, tomorrow: 8, long: false },
      { today: 10, tomorrow: 6, long: true },
      { today: 0, tomorrow: 6, long: true },
      { today: 10, tomorrow: 0, long: false },
    ].entries()) {
      const data = structuredClone(base);
      data.notes = [];
      data.purchases = Array.from({ length: scenario.today + scenario.tomorrow }, (_, i) => ({
        ...base.purchases[0],
        id: crypto.randomUUID(),
        projectId: i % 2 ? 'geometry-b' : 'p-home',
        name: `验收材料 ${i + 1}`,
        taskId: '',
        deadlineMode: 'fixed' as const,
        due: i < scenario.today ? day : plus(day, 1),
        originalDue: undefined,
        approvedDue: undefined,
        status: i % 3 ? ('待采购' as const) : ('已完成' as const),
      }));
      // Include real legacy-item rendering alongside purchases, preserving the requested totals.
      if (scenario.today) {
        data.purchases.shift();
        data.notes = [
          {
            ...base.notes[0],
            id: crypto.randomUUID(),
            title: '现场复核：门窗、电源与成品保护逐项检查',
            date: day,
            reminder: day,
          },
        ];
      }
      const workspace = await api(page, '/workspace');
      await api(page, '/workspace', 'PUT', { revision: workspace.revision, data });
      const studio = await api(page, '/studio-daily');
      const value = {
        ...emptyStudio(),
        ...studio.value,
        rules: scenario.long
          ? [0, 1, 2].map((i) => ({
              id: crypto.randomUUID(),
              text: `${i + 1}. 每日工作结束前检查门窗、电源及现场成品保护，妥善记录施工进度并及时反馈需要协调的问题。`.repeat(
                3,
              ),
              enabled: true,
              people: [f.employeeId],
              weekdays: [0, 1, 2, 3, 4, 5, 6],
              from: '',
              to: '',
            }))
          : [],
      };
      if (scenario.long)
        value.rules.push({
          ...value.rules[0],
          id: crypto.randomUUID(),
          text: '只分配给乙的内部工作要求',
          people: [f.employees[1].id],
        });
      const saved = await api(page, '/studio-daily', 'PUT', {
        requestId: crypto.randomUUID(),
        version: studio.version,
        value,
      });
      if (index === 1)
        await api(page, '/studio-daily/rotation', 'POST', {
          requestId: crypto.randomUUID(),
          version: saved.version,
          value: {
            action: 'configure',
            interval: 3,
            people: [f.employeeId, f.employees[1].id],
            start: day,
            currentDate: day,
          },
        });
      await page.reload();
      await expect(page.getByTestId('today-panel').locator('.agenda-item')).toHaveCount(
        scenario.today,
      );
      await expect(page.getByTestId('tomorrow-panel').locator('.agenda-item')).toHaveCount(
        scenario.tomorrow,
      );
      const expanded = await measure(page);
      aligned(expanded, true);
      records.push({ scenario, index, state: 'expanded', ...expanded });
      if (width === 1440 && index === 1) {
        await fullScreenshot(page, dir + '/home-expanded.png');
        await page.locator('.sd-grid').screenshot({ path: dir + '/studio-cards.png' });
      }
      await page.getByRole('button', { name: '收起今日事项', exact: true }).click();
      await expect
        .poll(async () => {
          const r = await measure(page);
          return r.leftHeight <= expanded.leftHeight;
        })
        .toBe(true);
      const mixed = await measure(page);
      aligned(mixed, false);
      records.push({ scenario, index, state: 'mixed', ...mixed });
      await page.getByRole('button', { name: '收起明日提醒', exact: true }).click();
      await expect
        .poll(async () => Math.abs((await measure(page)).agendaBottom))
        .toBeLessThanOrEqual(2);
      const collapsed = await measure(page);
      aligned(collapsed, true);
      records.push({ scenario, index, state: 'collapsed', ...collapsed });
      if (scenario.today > 6) expect(collapsed.leftHeight).toBeLessThan(expanded.leftHeight);
      if (width === 1440 && index === 1) {
        await fullScreenshot(page, dir + '/home-collapsed.png');
        await page
          .locator('.workspace-brief.agenda-brief')
          .screenshot({ path: dir + '/agenda-collapsed.png' });
        await page.getByRole('button', { name: '管理每日必做', exact: true }).click();
        await modalFits(page);
        const modal = page.getByRole('dialog', { name: '每日必做', exact: true });
        const list = await modal.locator('aside button').evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          }),
        );
        for (let i = 1; i < list.length; i++)
          expect(
            list[i].top - list[i - 1].bottom,
            'requirement summaries must not overlap',
          ).toBeGreaterThanOrEqual(0);
        await modal.locator('aside button').nth(1).click();
        await modal
          .getByLabel('工作要求', { exact: true })
          .fill('已修改的验收要求：及时复核施工进度。');
        await modal.getByRole('button', { name: '保存', exact: true }).click();
        await expect(modal).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId('studio-rules')).toContainText('已修改的验收要求');
        await page.getByRole('button', { name: '管理每日必做', exact: true }).click();
        await modal
          .getByLabel('工作要求', { exact: true })
          .fill('新增验收要求：工作结束前复核现场安全。');
        await modal.getByLabel('测试员工甲', { exact: true }).check();
        await expect(modal.getByRole('button', { name: '全体员工', exact: true })).toHaveAttribute(
          'aria-pressed',
          'false',
        );
        await modal.screenshot({ path: dir + '/daily-editor.png' });
        await modal.getByRole('button', { name: '保存', exact: true }).click();
        await expect(modal).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId('studio-rules')).toContainText('新增验收要求');
        await page.getByRole('button', { name: '编辑值日', exact: true }).click();
        await modalFits(page);
        const duty = page.getByRole('dialog', { name: '编辑值日', exact: true });
        await expect(duty.locator('input[type=date]')).toHaveCount(1);
        await duty.getByLabel('轮换周期', { exact: true }).selectOption('7');
        await duty.screenshot({ path: dir + '/duty-editor.png' });
        await duty.getByRole('button', { name: '确认预览并保存', exact: true }).click();
        await expect(duty).toHaveCount(0);
        await page.reload();
        await expect(page.locator('.sd-duty')).toContainText('每7天');
        await page.getByRole('button', { name: '查看排班', exact: true }).click();
        await modalFits(page);
        await page.getByRole('dialog').screenshot({ path: dir + '/schedule.png' });
        await page.keyboard.press('Escape');
        await api(page, '/auth/logout', 'POST', {});
        await page.reload();
        await login(page, f.login, f.password);
        await expect(page.getByTestId('studio-rules')).toContainText('新增验收要求');
        await expect(page.locator('.sd-duty')).toContainText('每7天');
        const context = await browser.newContext({
          baseURL: new URL(page.url()).origin,
          viewport: { width, height: 1000 },
        });
        const staff = await context.newPage();
        await login(staff, f.employee, f.password);
        await expect(staff.getByTestId('studio-rules')).toContainText('新增验收要求');
        await expect(staff.getByTestId('studio-rules')).not.toContainText('只分配给乙');
        await expect(staff.getByRole('button', { name: '管理每日必做', exact: true })).toHaveCount(
          0,
        );
        await expect(staff.getByRole('button', { name: '编辑值日', exact: true })).toHaveCount(0);
        aligned(await measure(staff), true);
        await fullScreenshot(staff, dir + '/staff-readonly.png');
        await context.close();
      }
    }
    await page.setViewportSize({ width: Math.round(width * 0.9), height: 900 });
    aligned(await measure(page), true);
    await writeFile(`${dir}/geometry-${width}.json`, JSON.stringify(records, null, 2));
    await page.setViewportSize({ width: 1024, height: 900 });
    const stack = await page.locator('.sd-grid').evaluate((e) => {
      const cards = Array.from(e.children).map((c) => c.getBoundingClientRect());
      return {
        firstBottom: cards[0].bottom,
        secondTop: cards[1].top,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(stack.secondTop).toBeGreaterThan(stack.firstBottom);
    expect(stack.overflow).toBe(false);
  });
