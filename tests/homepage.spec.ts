import { test, expect, type Page } from '@playwright/test';
import { boot, fixture, restore, state, closeToast } from './helpers';
const widths = [1440, 1280, 1024, 390];
async function start(page: Page, empty = false) {
  await page.clock.setFixedTime(new Date('2026-10-28T02:00:00Z'));
  await boot(page);
  const d = fixture();
  if (empty) {
    d.tasks = [];
    d.notes = [];
    d.purchases = [];
  }
  await restore(page, d);
  await closeToast(page);
  await expect.poll(async () => (await state(page)).tasks.length).toBe(d.tasks.length);
  await expect(page.locator('.save-state')).toContainText('已保存');
  return state(page);
}
for (const width of widths)
  test(`home ${width}: aligned real metrics, compact empty cards, readable controls and natural-day grid`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const original = await start(page, true);
    await expect(page.locator('.app-shell')).toHaveClass(/homepage/);
    const stats = page.locator('.stat-card');
    await expect(stats).toHaveCount(5);
    expect(await stats.locator('strong').allTextContents()).toEqual([
      '1',
      '1',
      '暂无',
      '暂无',
      '暂无',
    ]);
    expect(await page.locator('.stat-card.attention').count()).toBe(0);
    const geometry = await stats.evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect(),
          n = e.querySelector('strong')!.getBoundingClientRect();
        return { y: r.top, w: r.width, h: r.height, offset: n.top - r.top };
      }),
    );
    expect(new Set(geometry.map((g) => g.h)).size).toBe(1);
    expect(new Set(geometry.map((g) => Math.round(g.offset))).size).toBe(1);
    const topRow = geometry.filter((g) => g.y === geometry[0].y);
    expect(topRow).toHaveLength(width >= 1280 ? 5 : width === 1024 ? 3 : 2);
    const cards = page.locator('.workspace-brief .panel');
    await expect(cards).toHaveCount(3);
    const boxes = await cards.evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height));
    expect(new Set(boxes).size).toBe(1);
    expect(Math.max(...boxes)).toBeLessThan(270);
    await expect(page.locator('.brief-empty')).toHaveCount(3);
    await expect(page.locator('.workspace-status-group,.local-notice')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '备份数据', exact: true })).toBeVisible();
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect(await page.locator('h1').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(
      24,
    );
    for (const selector of [
      '.stat-card small',
      '.brief-actions button',
      '.date-label span',
      '.date-cell span',
      '.legend button',
    ]) {
      expect(
        await page
          .locator(selector)
          .first()
          .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
      ).toBeGreaterThanOrEqual(12);
    }
    await page.locator('#project-timeline').scrollIntoViewIfNeeded();
    const toolbar = page.locator('.schedule-section > .section-heading > .toolbar');
    const controls = await toolbar
      .locator(':scope > button,:scope > .date-picker-compact')
      .evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return { y: r.y, h: r.height, x: r.x, right: r.right };
        }),
      );
    for (const c of controls) {
      expect(c.h).toBe(controls[0].h);
      expect(c.right).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < controls.length; i++)
      if (Math.abs(controls[i].y - controls[i - 1].y) < 2)
        expect(controls[i].x).toBeGreaterThanOrEqual(controls[i - 1].right);
    const scroll = page.getByTestId('gantt-scroll');
    const left = await page.locator('.trade-label').first().boundingBox();
    await scroll.evaluate((e) => (e.scrollLeft += 224));
    await expect
      .poll(async () => Math.round((await page.locator('.trade-label').first().boundingBox())!.x))
      .toBe(Math.round(left!.x));
    const date = await scroll.locator('.date-cell').nth(5).getAttribute('aria-label');
    const day = date!.match(/\d{4}-\d{2}-\d{2}/)![0];
    const head = (await scroll
      .getByRole('button', { name: `查看 ${day} 事项`, exact: true })
      .boundingBox())!;
    const cell = (await scroll
      .locator('.trade-row')
      .first()
      .locator(`[data-date="${day}"]`)
      .boundingBox())!;
    expect(head.width).toBe(56);
    expect(cell.width).toBe(56);
    expect(head.x).toBeCloseTo(cell.x, 1);
    const position = await scroll.evaluate((e) => e.scrollLeft);
    await toolbar.getByRole('button', { name: '施工任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建施工任务', exact: true });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeLessThan(950);
    await dialog.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    expect(await scroll.evaluate((e) => e.scrollLeft)).toBe(position);
    expect(await state(page)).toEqual(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/chunmo-home-empty-${width}.png`, fullPage: true });
  });
for (const width of [1280, 390])
  test(`home ${width}: note actions, long lists and stable procurement data`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const original = await start(page),
      today = page.getByTestId('today-panel');
    await expect(today).toContainText('确认厨房插座定位');
    await expect(today).not.toContainText('电线及线管');
    await today.locator('.note-main').first().click();
    await expect(page.getByRole('dialog', { name: '编辑每日事项', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    expect(await state(page)).toEqual(original);
    const long = structuredClone(original);
    long.notes = Array.from({ length: 8 }, (_, i) => ({
      ...original.notes[0],
      id: `home-list-${i}`,
      title: `现场复核${i}`,
      date: '2026-10-28',
      content: '逐项核对现场要求。',
    }));
    await restore(page, long);
    await closeToast(page);
    await today.getByRole('button', { name: '展开今日事项', exact: true }).click();
    expect(
      await today.locator('.brief-content').evaluate((e) => e.scrollHeight > e.clientHeight),
    ).toBe(true);
    await today.locator('[data-note-id="home-list-7"] .note-main').click();
    await expect(page.getByRole('dialog', { name: '编辑每日事项', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    expect((await state(page)).purchases).toEqual(original.purchases);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
test('home and subpages share layout rules without altering saved records', async ({ page }) => {
  const original = await start(page);
  const sample = () =>
    page.locator('main,.topbar').evaluateAll((es) =>
      es.map((e) => {
        const s = getComputedStyle(e),
          r = e.getBoundingClientRect();
        return [s.padding, r.x, r.width];
      }),
    );
  const home = await sample();
  for (const name of ['事项管理', '人员管理', '材料资产管理']) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(await sample()).toEqual(home);
  }
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  expect(await state(page)).toEqual(original);
});
