import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { emptyStudio, studioDay } from '../src/lib/studio-daily';
import { plus } from '../src/lib/model';

test.use({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const dir = 'docs/screenshots/home-polish';
async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const response = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw Error('Fixture API ' + response.status);
      return response.json();
    },
    { path, method, body },
  );
}
async function alignedColumns(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluateAll((rows) => {
    const columns = rows.map((row) =>
      Array.from(row.children).map((cell) => {
        const r = cell.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    return {
      rows: rows.length,
      delta: Math.max(
        ...[0, 1, 2].flatMap((i) => [
          Math.max(...columns.map((c) => c[i].left)) - Math.min(...columns.map((c) => c[i].left)),
          Math.max(...columns.map((c) => c[i].right)) - Math.min(...columns.map((c) => c[i].right)),
        ]),
      ),
    };
  });
  expect(geometry.rows).toBe(3);
  expect(geometry.delta).toBeLessThanOrEqual(2);
  return geometry.delta;
}

test('desktop project surfaces, aligned three-round preview and gradient duty card', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const f = await fixtureAccounts(3);
  const names = ['李', '周设计', '负责现场与成品保护的值日同事'];
  for (const [i, employee] of f.employees.entries())
    await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', [names[i], employee.id]);
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const data = fixture(),
    day = studioDay();
  data.projects = ['林间工地', '江畔工地', '庭院工地'].map((name, i) => ({
    ...data.projects[0],
    id: 'polish-' + i,
    name,
  }));
  data.tasks = [];
  data.trades = [];
  data.notes = data.projects.flatMap((p, i) =>
    [0, 1].map((tomorrow) => ({
      ...data.notes[0],
      id: crypto.randomUUID(),
      projectId: p.id,
      title: p.name + '门窗复核',
      date: plus(day, tomorrow),
      reminder: plus(day, tomorrow),
      done: i === 2,
    })),
  );
  data.purchases = data.projects.flatMap((p) =>
    [0, 1].flatMap((tomorrow) =>
      ['待采购', '已下单', '已到货', '已完成'].map((status) => ({
        ...data.purchases[0],
        id: crypto.randomUUID(),
        projectId: p.id,
        taskId: '',
        name: p.name + status + '材料',
        deadlineMode: 'fixed' as const,
        due: plus(day, tomorrow),
        status: status as (typeof data.purchases)[0]['status'],
      })),
    ),
  );
  const workspace = await api(page, '/workspace');
  await api(page, '/workspace', 'PUT', { revision: workspace.revision, data });
  const studio = await api(page, '/studio-daily');
  await api(page, '/studio-daily', 'PUT', {
    requestId: crypto.randomUUID(),
    version: studio.version,
    value: {
      ...emptyStudio(),
      rules: [
        {
          id: crypto.randomUUID(),
          text: '工作结束前检查现场安全，复核门窗、电源和成品保护。',
          people: [],
          enabled: true,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          from: '',
          to: '',
        },
      ],
    },
  });
  await api(page, '/studio-daily/rotation', 'POST', {
    requestId: crypto.randomUUID(),
    version: studio.version + 1,
    value: {
      action: 'configure',
      people: f.employees.map((e) => e.id),
      interval: 7,
      start: day,
      currentDate: day,
    },
  });
  await page.reload();
  await expect(page.locator('.sd-duty')).toContainText(names[0]);
  await mkdir(dir, { recursive: true });
  const measurements = [];
  for (const width of [1280, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('.sd-grid').evaluate((grid) => {
      const [left, right] = Array.from(grid.children).map((c) => c.getBoundingClientRect());
      return {
        top: Math.abs(left.top - right.top),
        bottom: Math.abs(left.bottom - right.bottom),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.top).toBeLessThanOrEqual(2);
    expect(geometry.bottom).toBeLessThanOrEqual(2);
    expect(geometry.overflow).toBe(false);
    const colors = await page
      .locator('.workspace-brief.agenda-brief .agenda-item')
      .evaluateAll((cards) =>
        cards.map((c) => ({
          project: c.getAttribute('data-agenda-project'),
          kind: c.getAttribute('data-agenda-kind'),
          actual: getComputedStyle(c).backgroundColor,
          expected: (() => {
            const probe = document.createElement('span');
            probe.style.color = getComputedStyle(c).getPropertyValue('--project-surface');
            c.append(probe);
            const result = getComputedStyle(probe).color;
            probe.remove();
            return result;
          })(),
          inner: getComputedStyle(c.querySelector('.agenda-item-main')!).backgroundColor,
        })),
      );
    expect(colors.length).toBe(30);
    expect(new Set(colors.map((c) => c.actual)).size).toBe(3);
    expect(new Set(colors.map((c) => c.kind)).size).toBe(2);
    for (const color of colors) {
      expect(color.actual).toBe(color.expected);
      expect(color.inner).toBe('rgba(0, 0, 0, 0)');
    }
    const duty = await page.locator('.sd-duty').evaluate((c) => {
      const style = getComputedStyle(c);
      return {
        background: style.backgroundImage,
        color: style.color,
        buttons: Array.from(c.querySelectorAll('button')).map((b) => ({
          color: getComputedStyle(b).color,
          background: getComputedStyle(b).backgroundColor,
        })),
      };
    });
    expect(duty.background).toContain('gradient');
    expect(duty.color).toBe('rgb(255, 255, 255)');
    for (const b of duty.buttons) {
      expect(b.color).toBe('rgb(255, 255, 255)');
      expect(b.background).toMatch(/^rgba/);
    }
    await page.getByRole('button', { name: '编辑值日', exact: true }).click();
    await page.getByLabel('轮换周期', { exact: true }).selectOption('7');
    const previewDelta = await alignedColumns(page, '.sd-preview > div');
    for (const [i, name] of names.entries()) {
      await expect(page.locator('.sd-preview > div').nth(i)).toContainText(name);
      await expect(page.locator('.sd-preview > div').nth(i).locator('time')).toHaveText(
        plus(day, i * 7),
      );
    }
    if (width === 1440)
      await page.getByRole('dialog').screenshot({ path: dir + '/duty-editor.png' });
    // Preview must use the same aligned columns after changing to a 3-day interval.
    await page.getByLabel('轮换周期', { exact: true }).selectOption('3');
    for (let i = 0; i < 3; i++)
      await expect(page.locator('.sd-preview time').nth(i)).toHaveText(plus(day, i * 3));
    await alignedColumns(page, '.sd-preview > div');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '查看排班', exact: true }).click();
    const scheduleDelta = await alignedColumns(page, '.sd-upcoming .sd-schedule-row');
    await expect(page.locator('.sd-schedule .sd-schedule-row')).toHaveCount(3);
    for (const [i, label] of ['当前轮次', '下一轮', '下下轮'].entries()) {
      const row = page.locator('.sd-upcoming .sd-schedule-row').nth(i);
      await expect(row).toContainText(names[i]);
      await expect(row).toContainText(label);
      await expect(row.locator('time')).toHaveText(plus(day, i * 7));
    }
    if (width === 1440) await page.getByRole('dialog').screenshot({ path: dir + '/schedule.png' });
    await page.keyboard.press('Escape');
    if (width === 1440) {
      await page.locator('.sd-grid').screenshot({ path: dir + '/studio-cards.png' });
      // Fit the whole reminder region before capturing, so the sticky app header
      // cannot cover its title in Chromium's element screenshot.
      await page.setViewportSize({ width, height: 2200 });
      await page
        .locator('.workspace-brief.agenda-brief')
        .screenshot({ path: dir + '/project-colors.png' });
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: dir + '/home.png', fullPage: true });
    }
    measurements.push({
      width,
      ...geometry,
      previewDelta,
      scheduleDelta,
      cardColors: [...new Set(colors.map((c) => c.actual))],
    });
  }
  await writeFile(dir + '/geometry.json', JSON.stringify(measurements, null, 2));
  // Ordinary employees see the same three-round schedule but no management entry.
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const staff = await context.newPage();
  await staff.goto('/');
  await staff.getByLabel('登录账号', { exact: true }).fill(f.employee);
  await staff.getByLabel('登录密码', { exact: true }).fill(f.password);
  await staff.getByRole('button', { name: '登录', exact: true }).click();
  await expect(staff.getByRole('button', { name: '编辑值日', exact: true })).toHaveCount(0);
  await staff.getByRole('button', { name: '查看排班', exact: true }).click();
  await expect(staff.locator('.sd-upcoming .sd-schedule-row')).toHaveCount(3);
  await context.close();
});
