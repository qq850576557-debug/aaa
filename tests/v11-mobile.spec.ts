import { test, expect } from '@playwright/test';
import { boot, fixture, restore, state, closeToast } from './helpers';

function peopleFixture() {
  const data = fixture();
  data.people = [
    {
      id: 'touch-worker-a',
      name: '王建国',
      role: '施工人员',
      trade: '水电',
      notes: '',
      active: true,
    },
    {
      id: 'touch-worker-b',
      name: '张师傅',
      role: '施工人员',
      trade: '水电',
      notes: '',
      active: true,
    },
  ];
  data.trades.forEach((trade) => {
    trade.staffIds = (data.people ?? []).map((person) => person.id);
  });
  return data;
}
for (const width of [320, 375, 390, 430]) {
  test(`V1.1 touch ${width}px: trade name, days, people and order controls have separate readable bounds`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 880 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    try {
      await boot(page);
      await restore(page, peopleFixture());
      await closeToast(page);
      const header = await page.locator('.topbar').evaluate((el) => {
        const rect = (selector: string) => {
          const r = el.querySelector(selector)!.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        const brandName = el.querySelector('.mobile-brand .brand-name')!;
        const saved = el.querySelector('.save-state > span')!;
        return {
          brand: rect('.mobile-brand'),
          account: rect('.cloud-control'),
          project: rect('.active-project'),
          saved: rect('.save-state'),
          nameFits: brandName.scrollWidth <= brandName.clientWidth,
          saveFits: saved.scrollWidth <= saved.clientWidth,
        };
      });
      expect(header.nameFits).toBe(true);
      expect(header.saveFits).toBe(true);
      expect(header.brand.right).toBeLessThanOrEqual(header.account.x);
      expect(header.account.height).toBeGreaterThanOrEqual(44);
      expect(Math.max(header.brand.bottom, header.account.bottom)).toBeLessThanOrEqual(
        Math.min(header.project.y, header.saved.y),
      );
      expect(header.project.width).toBeGreaterThanOrEqual(150);
      expect(header.project.right).toBeLessThanOrEqual(header.saved.x);
      expect(header.saved.right).toBeLessThanOrEqual(width);
      if (width === 390) await page.screenshot({ path: '/tmp/chunmo-v11-mobile-header.png' });
      await page.locator('#project-timeline').scrollIntoViewIfNeeded();
      const geometry = await page.locator('.trade-row').evaluateAll((rows) =>
        rows.map((row) => {
          const label = row.querySelector('.trade-label')!;
          const rect = (el: Element) => {
            const r = el.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            };
          };
          const name = row.querySelector('.trade-title > button[title="编辑工种"] > span')!;
          const days = row.querySelector('.trade-title small')!;
          const workers = row.querySelector('.trade-workers')!;
          const arrows = [...row.querySelectorAll('.trade-meta > button')];
          return {
            label: rect(label),
            name: rect(name),
            days: rect(days),
            workers: rect(workers),
            arrows: arrows.map(rect),
            row: rect(row),
            nameOverflows: name.scrollHeight > name.clientHeight + 1,
          };
        }),
      );
      for (const row of geometry) {
        expect(row.row.height).toBeGreaterThanOrEqual(124);
        expect(row.label.width).toBeGreaterThanOrEqual(162);
        expect(row.label.width).toBeLessThanOrEqual(190);
        expect(row.nameOverflows).toBe(false);
        expect(row.name.bottom).toBeLessThanOrEqual(row.days.y + 1);
        expect(row.days.bottom).toBeLessThanOrEqual(row.workers.y + 1);
        expect(row.workers.bottom).toBeLessThanOrEqual(row.label.bottom);
        for (const arrow of row.arrows) {
          expect(arrow.width).toBeGreaterThanOrEqual(44);
          expect(arrow.height).toBeGreaterThanOrEqual(44);
          expect(arrow.x).toBeGreaterThanOrEqual(Math.max(row.name.right, row.workers.right));
          expect(arrow.right).toBeLessThanOrEqual(row.label.right);
        }
        expect(row.arrows[0].bottom).toBeLessThanOrEqual(row.arrows[1].y);
      }
      const scroller = page.getByTestId('gantt-scroll');
      await scroller.evaluate((el) => {
        el.scrollLeft = 250;
      });
      expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
      const label = await page.locator('.trade-label').first().boundingBox(),
        frame = await scroller.boundingBox();
      expect(Math.abs(label!.x - frame!.x)).toBeLessThan(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const nav = page.locator('.sidebar nav');
      const navBox = await nav.boundingBox();
      expect(navBox!.width).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: '人员管理', exact: true }).tap();
      await expect(page.locator('.people-panel')).toBeVisible();
      await page.getByRole('button', { name: '项目工作空间', exact: true }).tap();
      await expect(page.locator('#project-timeline')).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test('V1.1 desktop keeps compact rows while mobile reorder and task details remain functional', async ({
  page,
}) => {
  await boot(page);
  await restore(page, peopleFixture());
  await closeToast(page);
  await expect(page.locator('.trade-row').first()).toHaveCSS('height', '68px');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.trade-row').first()).toHaveCSS('height', '124px');
  const before = await state(page),
    first = before.trades[0];
  await page.getByRole('button', { name: `下移工种${first.name}`, exact: true }).click();
  await expect
    .poll(async () => (await state(page)).trades.find((trade) => trade.id === first.id)?.order)
    .toBe(1);
  await page.locator('.task-details-list summary').click();
  await page.getByRole('button', { name: '编辑任务现场保护与拆改', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑施工任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.trade-row').first()).toHaveCSS('height', '68px');
});

test('V1.1 real touch pointer drags a time block and persists its dates', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await boot(page);
    await restore(page, peopleFixture());
    await closeToast(page);
    const bar = page.getByTestId('task-bar').filter({ hasText: '现场保护与拆改' });
    await bar.scrollIntoViewIfNeeded();
    const box = (await bar.boundingBox())!;
    const x = Math.max(box.x + 22, Math.min(box.x + box.width / 2, 310)),
      y = box.y + 22;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 20, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 56, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const currentOnly = page.getByRole('button', { name: '仅调整当前工序', exact: true });
    if (await currentOnly.isVisible()) await currentOnly.tap();
    await expect
      .poll(async () => (await state(page)).tasks.find((task) => task.id === 't-first')?.start)
      .toBe('2026-10-23');
    await page
      .locator('#project-timeline')
      .screenshot({ path: '/tmp/chunmo-v11-mobile-timeline.png' });
  } finally {
    await context.close();
  }
});
