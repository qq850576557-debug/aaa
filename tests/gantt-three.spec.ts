import { test, expect, type Page, type Locator } from '@playwright/test';
import { boot, restore, fixture, state, closeToast } from './helpers';
async function move(page: Page, bar: Locator, days: number) {
  await bar.scrollIntoViewIfNeeded();
  const r = (await bar.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + days * 56, r.y + r.height / 2, { steps: 12 });
  await page.mouse.up();
}
for (const width of [1440, 390])
  test(`toolbar ${width}: accessible date without visible label and aligned controls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page);
    await restore(page);
    await closeToast(page);
    const toolbar = page.locator('.schedule-section > .section-heading > .toolbar');
    await toolbar.scrollIntoViewIfNeeded();
    await expect(toolbar.getByLabel('定位日期', { exact: true })).toBeVisible();
    await expect(toolbar.locator('label')).toHaveClass('sr-only');
    const boxes = await toolbar.locator(':scope > *').evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
    if (width === 1440)
      expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThan(
        2,
      );
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(
          boxes[i].x + boxes[i].w <= boxes[j].x + 1 ||
            boxes[j].x + boxes[j].w <= boxes[i].x + 1 ||
            boxes[i].y + boxes[i].h <= boxes[j].y + 1 ||
            boxes[j].y + boxes[j].h <= boxes[i].y + 1,
        ).toBe(true);
    await toolbar.getByRole('button', { name: '选择定位日期', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '定位日期日历', exact: true })).toBeVisible();
  });
test('merged view moves/resizes all raw records, preserves notes/references and survives refresh', async ({
  page,
}) => {
  const d = fixture();
  d.tasks = d.tasks.slice(0, 1);
  d.tasks[0].end = '2026-10-26';
  d.tasks.push({
    ...d.tasks[0],
    id: 'overlap',
    start: '2026-10-24',
    end: '2026-10-27',
    notes: '不能丢失的备注',
  });
  d.tasks.push({ ...d.tasks[0], id: 'adjacent', start: '2026-10-28', end: '2026-10-29' });
  d.tasks.push({ ...d.tasks[0], id: 'gap', start: '2026-11-01', end: '2026-11-02' });
  d.purchases = [];
  d.notes = [];
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
  await boot(page);
  await restore(page, d);
  await closeToast(page);
  const row = page.locator('.trade-row').first();
  await expect(row.getByTestId('task-bar')).toHaveCount(2);
  const merged = row.getByTestId('task-bar').first();
  await expect(merged).toHaveAttribute('aria-label', /2026-10-22 至 2026-10-29，8 天/);
  await move(page, merged, -1);
  await expect.poll(async () => (await state(page)).tasks[1].start).toBe('2026-10-23');
  expect((await state(page)).tasks).toHaveLength(4);
  expect((await state(page)).tasks[1].notes).toBe('不能丢失的备注');
  await move(page, merged.getByTestId('resize-end'), -2);
  await expect.poll(async () => (await state(page)).tasks[2].end).toBe('2026-10-26');
  await expect(merged).toHaveAttribute('aria-label', /2026-10-21 至 2026-10-26，6 天/);
  await merged.click({ button: 'right' });
  await expect(page.getByLabel('选择原始任务记录')).toBeVisible();
  await page.getByLabel('选择原始任务记录').selectOption('overlap');
  await page.getByRole('menuitem', { name: '编辑任务详情' }).click();
  await expect(page.getByRole('dialog').getByLabel('施工备注')).toHaveValue('不能丢失的备注');
  await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).tasks).toHaveLength(4);
  await expect(page.locator('.trade-row').first().getByTestId('task-bar')).toHaveCount(2);
});
for (const mode of ['move', 'end'] as const)
  for (const sync of [true, false])
    test(`earlier ${mode}, sync=${sync}: one decision then persistent dates`, async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
      const d = fixture();
      d.tasks = d.tasks.slice(0, 2);
      d.tasks[1].start = '2026-10-28';
      d.tasks[1].end = '2026-10-30';
      d.notes = [];
      d.purchases = [];
      await boot(page);
      await restore(page, d);
      await closeToast(page);
      const bar = page.getByTestId('task-bar').first();
      await move(page, mode === 'move' ? bar : bar.getByTestId('resize-end'), -1);
      const decision = page.getByRole('dialog', {
        name: '当前工序已提前，是否同步提前后续工序？',
        exact: true,
      });
      await expect(decision).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      expect((await state(page)).tasks).toEqual(d.tasks);
      await decision
        .getByRole('button', { name: sync ? '同步提前' : '不调整', exact: true })
        .click();
      await expect(decision).toHaveCount(0);
      await expect.poll(async () => (await state(page)).tasks[0].end).toBe('2026-10-24');
      expect((await state(page)).tasks[1].start).toBe(sync ? '2026-10-27' : '2026-10-28');
      await page.reload();
      await expect(page.locator('.save-state')).toContainText('已保存');
      expect((await state(page)).tasks[1].start).toBe(sync ? '2026-10-27' : '2026-10-28');
    });
