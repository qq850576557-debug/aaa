import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { boot, fixture, restore, state, closeToast } from './helpers';
import { plus } from '../src/lib/model';
const output =
  process.env.CHUNMO_TIMELINE_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/timeline-ui';
test.use({ timezoneId: 'Asia/Shanghai' });
for (const width of [1440, 1280])
  test(`timeline wheel ${width}: scoped movement, exclusions, alignment and retained drag/resize/create`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-29T12:00:00+08:00'));
    await boot(page);
    const d = fixture();
    d.tasks = [d.tasks[0]];
    d.purchases = d.purchases.map((p) => ({ ...p, taskId: '', deadlineMode: 'fixed' }));
    await restore(page, d);
    await closeToast(page);
    const baseline = await state(page),
      scroll = page.getByTestId('gantt-scroll');
    await page.getByLabel('定位日期', { exact: true }).fill('');
    await page.getByLabel('定位日期', { exact: true }).fill('2026-10-22');
    await scroll.scrollIntoViewIfNeeded();
    const firstCell = page
      .locator('.trade-row')
      .first()
      .locator('.track-cell[data-date="2026-10-24"]');
    const cell = (await firstCell.boundingBox())!;
    await page.mouse.move(cell.x + 20, cell.y + 5);
    const before = await scroll.evaluate((e) => e.scrollLeft),
      beforePage = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 168);
    await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(before + 140);
    expect(await page.evaluate(() => window.scrollY)).toBe(beforePage);
    const right = await scroll.evaluate((e) => e.scrollLeft);
    await page.mouse.wheel(0, -112);
    await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeLessThan(right - 90);
    const left = await scroll.evaluate((e) => e.scrollLeft);
    await page.mouse.wheel(80, 5);
    await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(left + 60);
    expect(await state(page)).toEqual(baseline);
    // Same logical date occupies exactly the same x coordinate in header and rows after horizontal motion.
    const date = await page.locator('.date-cell').nth(5).getAttribute('aria-label');
    const key = date!.slice(3, 13);
    const hx = await page
      .getByRole('button', { name: `查看 ${key} 事项`, exact: true })
      .evaluate((e) => e.getBoundingClientRect().x);
    const tx = await page
      .locator('.trade-row')
      .first()
      .locator(`[data-date="${key}"]`)
      .evaluate((e) => e.getBoundingClientRect().x);
    expect(Math.abs(hx - tx)).toBeLessThan(1);
    const control = await firstCell.evaluate((e) => {
      const ev = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 30,
        ctrlKey: true,
      });
      e.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(control).toBe(false);
    // Very small trackpad deltas must accumulate even when starting at the left boundary.
    expect(
      await scroll.evaluate(async (el) => {
        el.scrollLeft = 0;
        const track = el.querySelector('.track')!;
        for (let i = 0; i < 3; i++) {
          track.dispatchEvent(
            new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 0.4 }),
          );
          await new Promise(requestAnimationFrame);
        }
        return el.scrollLeft;
      }),
    ).toBeGreaterThan(0);

    await page.getByLabel('定位日期', { exact: true }).fill('');
    await page.getByLabel('定位日期', { exact: true }).fill('2026-10-22');
    await scroll.scrollIntoViewIfNeeded();
    const bar = page.getByTestId('task-bar').first();
    await bar.hover({ position: { x: 100, y: 12 } });
    const atBar = await scroll.evaluate((e) => e.scrollLeft);
    await page.mouse.wheel(0, 90);
    await page.waitForTimeout(100);
    expect(await scroll.evaluate((e) => e.scrollLeft)).toBe(atBar);
    await page.getByLabel('定位日期', { exact: true }).fill('');
    await page.getByLabel('定位日期', { exact: true }).fill('2026-10-22');
    await scroll.scrollIntoViewIfNeeded();
    await bar.hover({ position: { x: 100, y: 12 } });
    const start = bar.getByTestId('resize-start'),
      end = bar.getByTestId('resize-end');
    expect(await start.evaluate((e) => getComputedStyle(e, '::after').content)).toBe('none');
    expect(await start.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
    await end.hover();
    expect(await end.evaluate((e) => getComputedStyle(e).cursor)).toBe('ew-resize');
    expect(await end.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(await start.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/edge-${width}.png`, animations: 'disabled' });
    await bar.hover({ position: { x: 100, y: 12 } });
    await expect
      .poll(() => end.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe('rgba(0, 0, 0, 0)');
    const r = (await bar.boundingBox())!;
    await page.mouse.move(r.x + 100, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + 156, r.y + r.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await state(page)).tasks[0].start)
      .toBe(plus(d.tasks[0].start, 1));
    const moved = (await state(page)).tasks[0],
      er = (await end.boundingBox())!;
    await page.mouse.move(er.x + er.width / 2, er.y + er.height / 2);
    await page.mouse.down();
    await page.mouse.move(er.x + er.width / 2 + 56, er.y + er.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await state(page)).tasks[0].end).toBe(plus(moved.end, 1));
    const resized = (await state(page)).tasks[0];
    await page.reload();
    expect((await state(page)).tasks[0]).toEqual(resized);
    await page.getByLabel('定位日期', { exact: true }).fill('2026-10-29');
    await page.locator('.trade-row').nth(2).locator('[data-date="2026-11-02"]').dblclick();
    await expect.poll(async () => (await state(page)).tasks.length).toBe(2);
    expect((await state(page)).purchases).toEqual(baseline.purchases);
    expect((await state(page)).notes).toEqual(baseline.notes);
    const savedX = await scroll.evaluate((e) => e.scrollLeft);
    await page.locator('h1').scrollIntoViewIfNeeded();
    await page.locator('h1').hover();
    const py = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 240);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(py);
    expect(await scroll.evaluate((e) => e.scrollLeft)).toBe(savedX);
  });
for (const width of [1440, 390])
  test(`project UI ${width}: one stable theme, purchase cards and compact navigation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await boot(page);
    const d = fixture();
    d.projects.push({ ...d.projects[0], id: 'theme-other', name: '云杉庭 · 二号工地' });
    d.purchases = Array.from({ length: 4 }, (_, i) => ({
      ...d.purchases[0],
      id: 'pc' + i,
      name: '现场采购材料' + i,
      owner: '李采购',
      notes: i % 2 ? '核对规格，按约定时间到场。' : '',
      status: i === 3 ? '已完成' : '待采购',
    }));
    await restore(page, d);
    await closeToast(page);
    const original = await state(page);
    await expect(page.getByRole('button', { name: '记录状态看板', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '事项管理', exact: true })).toBeVisible();
    if (width < 700) await page.locator('.mobile-project-toggle').click();
    const first = page.locator('[data-project-id="p-home"]'),
      second = page.locator('[data-project-id="theme-other"]');
    const hue = await first.getAttribute('data-project-hue');
    expect(await second.getAttribute('data-project-hue')).not.toBe(hue);
    if (width >= 700) {
      const height = (await first.boundingBox())!.height;
      expect(height).toBeLessThan(155);
      expect(height).toBeGreaterThan(100);
    }
    if (width < 700) await page.locator('.mobile-project-toggle').click();
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await expect(page.locator('.purchase-list .purchase-card')).toHaveCount(4);
    await expect(page.locator('.purchase-list')).toContainText(d.projects[0].name);
    await expect(page.locator('.purchase-list')).toContainText('李采购');
    expect(
      await page
        .locator('.purchase-list .purchase-card')
        .first()
        .evaluate((e) => getComputedStyle(e).getPropertyValue('--project-hue').trim()),
    ).toBe(hue);
    const rects = await page.locator('.purchase-list .purchase-card').evaluateAll((es) =>
      es.map((e) => ({
        x: e.getBoundingClientRect().x,
        y: e.getBoundingClientRect().y,
        w: e.getBoundingClientRect().width,
        h: e.getBoundingClientRect().height,
        actionsY: e.querySelector('.purchase-actions')!.getBoundingClientRect().y,
      })),
    );
    for (let i = 1; i < rects.length; i++)
      if (Math.abs(rects[i].y - rects[i - 1].y) < 1) {
        expect(rects[i].h).toBe(rects[i - 1].h);
        expect(Math.abs(rects[i].actionsY - rects[i - 1].actionsY)).toBeLessThan(1);
      }
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: `${output}/purchases-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await expect(page.locator('.daily-records')).toHaveCount(0);
    expect((await state(page)).notes).toEqual(original.notes);
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await page.screenshot({
      path: `${output}/home-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(await state(page)).toEqual(original);
    await page.reload();
    expect(await page.locator('[data-project-id="p-home"]').getAttribute('data-project-hue')).toBe(
      hue,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
