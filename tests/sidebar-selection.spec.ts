import { test, expect } from '@playwright/test';
import { boot, fixture, restore, state, closeToast } from './helpers';
function luminance(css: string) {
  const rgb = css
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number)
    .map((x) => {
      const n = x / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
for (const width of [1440, 390])
  test(`selected sidebar project ${width}: light selection, readable details and unchanged project data`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await boot(page);
    const data = fixture();
    data.projects.push({ ...data.projects[0], id: 'sidebar-second', name: '云杉庭 · 二号工地' });
    await restore(page, data);
    await closeToast(page);
    const before = await state(page);
    for (const project of data.projects) {
      if (
        width < 700 &&
        !(await page.locator('.sidebar-project-list .project-select').first().isVisible())
      )
        await page.locator('.mobile-project-toggle').click();
      await page.getByRole('button', { name: `切换项目${project.name}`, exact: true }).click();
      if (
        width < 700 &&
        !(await page.locator('.sidebar-project-list .project-select').first().isVisible())
      )
        await page.locator('.mobile-project-toggle').click();
      const selected = page.locator(
        `.sidebar-project-list [data-project-id="${project.id}"] .project-select`,
      );
      await expect(selected).toHaveAttribute('aria-pressed', 'true');
      for (const hover of [false, true]) {
        if (hover) await selected.hover();
        else await page.mouse.move(width - 5, 10);
        await expect(selected).toHaveCSS(
          'background-color',
          hover ? 'rgb(217, 232, 222)' : 'rgb(229, 239, 232)',
        );
        const colors = await selected.evaluate((el) => ({
          background: getComputedStyle(el).backgroundColor,
          fields: [...el.querySelectorAll('.project-card-name,small,.project-card-dates')].map(
            (x) => ({ text: x.textContent, color: getComputedStyle(x).color }),
          ),
        }));
        const bg = luminance(colors.background);
        expect(bg).toBeGreaterThan(0.7);
        for (const field of colors.fields) {
          const ink = luminance(field.color),
            contrast = (Math.max(bg, ink) + 0.05) / (Math.min(bg, ink) + 0.05);
          expect(contrast, `${field.text} must remain legible`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    await page.screenshot({ path: `/tmp/chunmo-sidebar-selection-${width}.png` });
    expect(await state(page)).toEqual(before);
  });
