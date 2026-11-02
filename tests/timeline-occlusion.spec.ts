import { test, expect } from '@playwright/test';
import { boot, fixture, restore, closeToast, state } from './helpers';
for (const width of [1440, 390]) {
  test(`timeline ${width}: scrolled date markers are occluded by the full fixed label`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-28T02:00:00Z'));
    await boot(page);
    const data = fixture();
    data.notes[0].date = '2026-10-29';
    await restore(page, data);
    await closeToast(page);
    await expect(page.locator('.save-state')).toContainText('已保存');
    const before = await state(page);
    const scroll = page.getByTestId('gantt-scroll');
    await scroll.scrollIntoViewIfNeeded();
    const label = scroll.locator('.date-label');
    const selected = await scroll.evaluate((el) => {
      const label = el.querySelector('.date-label')!.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      for (const cell of el.querySelectorAll('.date-cell')) {
        const dot = cell.querySelector('.agenda-dot');
        if (!dot) continue;
        const r = dot.getBoundingClientRect();
        if (r.x > label.right + 8 && r.right < bounds.right) {
          return {
            name: cell.getAttribute('aria-label')!,
            delta: r.x + r.width / 2 - (label.x + label.width / 2),
          };
        }
      }
      return null;
    });
    expect(selected).not.toBeNull();
    await scroll.evaluate((el, delta) => {
      el.scrollLeft += delta;
    }, selected!.delta);
    const marker = scroll
      .getByRole('button', { name: selected!.name, exact: true })
      .locator('.agenda-dot');
    await expect
      .poll(async () => {
        const rect = await marker.boundingBox();
        if (!rect) return false;
        return page.evaluate(
          ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.date-label'),
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        );
      })
      .toBe(true);
    const a = (await label.boundingBox())!;
    const b = (await marker.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(a.y + a.height);
    expect(await state(page)).toEqual(before);
    await page.screenshot({ path: `/tmp/timeline-occlusion-${width}.png` });
  });
}
