import { test, expect } from '@playwright/test';
import { boot, fixture, restore, state, closeToast } from './helpers';
for (const width of [1440, 390])
  test(`V1.1 ${width}: three agenda cards expand; procurement delete and completion stay distinct`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.clock.setFixedTime(new Date('2026-10-28T02:00:00Z'));
    await boot(page);
    const d = fixture(),
      memo = d.notes.find((n) => n.kind === '项目备忘')!;
    d.purchases = Array.from({ length: 8 }, (_, i) => ({
      ...d.purchases[0],
      id: 'v11-p' + i,
      taskId: '',
      due: '2026-10-28',
      deadlineMode: 'fixed' as const,
      name: '核查材料' + i,
    }));
    d.notes = Array.from({ length: 4 }, (_, i) => [
      {
        ...memo,
        id: 'today' + i,
        kind: '施工安排' as const,
        title: '今日记录' + i,
        date: '2026-10-28',
      },
      {
        ...memo,
        id: 'tomorrow' + i,
        kind: '施工安排' as const,
        title: '明日记录' + i,
        date: '2026-10-29',
      },
      { ...memo, id: 'memo' + i, title: '完整备忘' + i },
    ]).flat();
    await restore(page, d);
    await closeToast(page);
    await expect(page.getByTestId('memo-panel')).toHaveCount(0);
    for (const title of ['今日事项', '明日提醒']) {
      const panel = page
        .locator('.brief-panel')
        .filter({ has: page.getByRole('heading', { name: new RegExp('^' + title) }) });
      await expect(
        panel.getByRole('button', { name: '展开' + title, exact: true }),
      ).toHaveAttribute('aria-expanded', 'false');
      expect(await panel.locator('.brief-content').evaluate((e) => e.children.length)).toBe(3);
      await panel.getByRole('button', { name: '展开' + title, exact: true }).click();
      expect(await panel.locator('.brief-content').evaluate((e) => e.children.length)).toBe(
        title === '今日事项' ? 12 : 4,
      );
      await panel.getByRole('button', { name: '收起' + title, exact: true }).click();
    }
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    const list = page.locator('.purchase-list');
    await list.getByRole('button', { name: '删除采购核查材料0', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '删除「核查材料0」？', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect((await state(page)).purchases).toHaveLength(8);
    await list.getByRole('button', { name: '删除采购核查材料0', exact: true }).click();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    expect((await state(page)).purchases).toHaveLength(7);
    await list.getByRole('button', { name: '完成采购核查材料1', exact: true }).click();
    expect((await state(page)).purchases.find((p) => p.id === 'v11-p1')?.status).toBe('已完成');
    await page.getByLabel('采购记录筛选', { exact: true }).selectOption('已完成');
    await expect(list.locator('.purchase-row')).toHaveCount(1);
    expect((await state(page)).notes).toHaveLength(12);
  });
test('V1.1 held pointer scrolls continuously at the timeline edge, stops in center and saves aligned dates', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.clock.setFixedTime(new Date('2026-10-28T02:00:00Z'));
  await boot(page);
  const d = fixture();
  d.tasks = [d.tasks[0]];
  d.purchases = [];
  d.notes = [];
  await restore(page, d);
  await closeToast(page);
  await page.getByLabel('定位日期', { exact: true }).fill('2026-10-22');
  const scroll = page.getByTestId('gantt-scroll');
  await scroll.scrollIntoViewIfNeeded();
  const bar = page.getByTestId('task-bar').first();
  await bar.hover();
  const r = (await bar.boundingBox())!,
    rect = (await scroll.boundingBox())!,
    before = await scroll.evaluate((e) => e.scrollLeft);
  await page.mouse.move(r.x + Math.min(60, r.width / 2), r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 5, r.y + r.height / 2, { steps: 8 });
  await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(before + 56);
  await page.mouse.move(rect.x + rect.width / 2, r.y + r.height / 2);
  await page.waitForTimeout(100);
  const stopped = await scroll.evaluate((e) => e.scrollLeft);
  await page.waitForTimeout(250);
  expect(await scroll.evaluate((e) => e.scrollLeft)).toBe(stopped);
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).tasks[0].start).not.toBe(d.tasks[0].start);
  const saved = (await state(page)).tasks[0];
  expect(saved.end).not.toBe(d.tasks[0].end);
  await page.reload();
  expect((await state(page)).tasks[0]).toEqual(saved);
  // Continue with the left edge after reloading the first saved move.
  await page.getByLabel('定位日期', { exact: true }).fill(saved.start);
  await scroll.scrollIntoViewIfNeeded();
  const again = page.getByTestId('task-bar').first();
  await again.hover();
  const br = (await again.boundingBox())!,
    sr = (await scroll.boundingBox())!,
    label = (await page.locator('.trade-label').first().boundingBox())!;
  const beforeLeft = await scroll.evaluate((e) => e.scrollLeft);
  await page.mouse.move(br.x + Math.min(60, br.width / 2), br.y + br.height / 2);
  await page.mouse.down();
  await page.mouse.move(sr.x + label.width + 4, br.y + br.height / 2, { steps: 8 });
  await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeLessThan(beforeLeft - 56);
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).tasks[0].start < saved.start).toBe(true);
  const leftSaved = (await state(page)).tasks[0];
  await page.reload();
  expect((await state(page)).tasks[0]).toEqual(leftSaved);
  await expect(page.locator('.task-bar.overdue')).toHaveCount(0);
  await expect(page.locator('.stat-card').filter({ hasText: '已逾期施工' })).toHaveCount(0);
});
