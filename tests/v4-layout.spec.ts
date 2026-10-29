import { test, expect } from '@playwright/test';
import { boot, fixture, restore, state, closeToast } from './helpers';
for (const width of [1440, 390])
  test(`V4 ${width}: persistent selector, compact cards, direct creation and virtual dates`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
    await boot(page);
    const d = fixture();
    const p = { ...d.projects[0], id: 'second', name: '第二个项目' };
    d.projects.push(p);
    await restore(page, d);
    await closeToast(page);
    expect(await page.locator('.project-summary,.recent-section,.project-switch').count()).toBe(0);
    if (width === 390)
      await page
        .getByRole('button', { name: /栖桐里/ })
        .filter({ has: page.locator('.lucide-chevron-down') })
        .click();
    await expect(page.locator('.sidebar-project-list .project-card')).toHaveCount(2);
    await expect(page.locator('.project-card').first()).not.toContainText('上海市');
    await expect(page.locator('.project-card').first()).not.toContainText('已完成');
    if (width === 390) await page.locator('.mobile-project-toggle').click();
    if (width === 1440) {
      const boxes = await page
        .locator('.agenda-brief>.panel')
        .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().top));
      expect(new Set(boxes).size).toBe(1);
    }
    await page.locator('#project-timeline').scrollIntoViewIfNeeded();
    const scroll = page.getByTestId('gantt-scroll');
    await expect(scroll.locator('.date-cell.today')).toBeVisible();
    expect(await page.locator('.date-cell').count()).toBeLessThan(50);
    await expect(scroll).toHaveAttribute('data-range-end', /2031/);
    await page.locator('.trade-row').nth(2).locator('[data-date="2026-10-24"]').dblclick();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
    await expect(page.getByRole('button', { name: /上移工种|下移工种/ })).toHaveCount(0);
    await page.getByLabel('定位日期', { exact: true }).fill('2030-12-31');
    await expect(scroll.locator('.date-cell').filter({ hasText: '31' }).first()).toBeAttached();
    expect(await page.locator('.date-cell').count()).toBeLessThan(50);
    const before = await scroll.evaluate((e) => e.scrollLeft);
    if (width === 390) await page.locator('.mobile-project-toggle').click();
    await page.getByRole('button', { name: '切换项目第二个项目', exact: true }).click();
    expect(await scroll.evaluate((e) => e.scrollLeft)).toBe(before);
    await expect(page.locator('#project-timeline')).toBeVisible();
    await page.screenshot({ path: `/tmp/chunmo-v4-${width}.png`, fullPage: true });
  });

test('V4 future task dates persist, dragging stays aligned and hidden project fields survive edits', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
  await boot(page);
  const d = fixture();
  d.projects[0].actualStart = '2026-10-22';
  d.projects[0].actualEnd = '2026-12-20';
  await restore(page, d);
  await closeToast(page);
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑项目', exact: true });
  for (const text of ['项目地址', '实际开工日期', '实际完工日期'])
    await expect(form.getByLabel(text, { exact: true })).toHaveCount(0);
  await form.getByLabel('项目名称', { exact: true }).fill('保留旧资料');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects[0].name).toBe('保留旧资料');
  expect((await state(page)).projects[0]).toMatchObject({
    address: d.projects[0].address,
    actualStart: '2026-10-22',
    actualEnd: '2026-12-20',
  });
  await page.getByLabel('定位日期', { exact: true }).fill('2030-12-30');
  const row = page.locator('.trade-row').nth(3);
  await row.locator('[data-date="2030-12-31"]').dblclick();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  const task = (await state(page)).tasks[3];
  expect(task.start).toBe('2030-12-31');
  expect(task.tradeId).toBe(d.trades[3].id);
  const bar = page.locator(`[data-task-id="${task.id}"]`),
    box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 76, box.y + 12, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === task.id)?.start)
    .toBe('2031-01-01');
  await expect(page.locator('.schedule-forecast')).toContainText('预计延期');
  const scroll = page.getByTestId('gantt-scroll');
  expect(await scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(80000);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).tasks.find((t) => t.id === task.id)?.start).toBe('2031-01-01');
  await expect(scroll.locator('.date-cell.today')).toBeVisible();
});

test('V4 switching projects in notes preserves the module and returning to workspace keeps selection', async ({
  page,
}) => {
  await boot(page);
  const d = fixture();
  d.projects.push({ ...d.projects[0], id: 'second-context', name: '第二工作上下文' });
  await restore(page, d);
  await closeToast(page);
  await page.getByRole('button', { name: '事项与备忘', exact: true }).click();
  await page.getByRole('button', { name: '切换项目第二工作上下文', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: '每日事项与项目备忘', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.current-project-name')).toHaveText('第二工作上下文');
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await expect(page.locator('.current-project-name')).toHaveText('第二工作上下文');
});
