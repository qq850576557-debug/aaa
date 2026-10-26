import { test, expect } from '@playwright/test';
import { boot, restore, fixture, state, closeToast } from './helpers';
for (const width of [1440, 390])
  test(`refined ${width}px: equal quiet cards, contextual project settings and readable compact trade editor`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
    await boot(page);
    const d = fixture();
    d.tasks = [];
    d.notes = [];
    d.purchases = [];
    d.people = [
      { id: 'worker-ui', name: '陈师傅', role: '施工人员', trade: '水电', notes: '', active: true },
    ];
    await restore(page, d);
    await closeToast(page);
    const cards = page.locator('.workspace-brief .panel');
    const boxes = await cards.evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }),
    );
    expect(boxes).toHaveLength(4);
    expect(new Set(boxes.map((b) => b.h)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.w)).size).toBe(1);
    await expect(page.locator('.brief-empty')).toHaveCount(4);
    for (const p of await page.locator('.brief-empty').all()) await expect(p).toHaveText('暂无');
    await expect(
      page.locator('.project-toolbar').getByRole('button', { name: '编辑当前项目', exact: true }),
    ).toHaveCount(0);
    if (width === 390) await page.locator('.mobile-project-toggle').click();
    await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    if (width === 390) await page.locator('.mobile-project-toggle').click();
    await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '编辑工种', exact: true });
    expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(480);
    expect(await panel.evaluate((e) => e.matches(':modal'))).toBe(false);
    const staff = (await panel.locator('.staff-picker').boundingBox())!,
      colors = (await panel.locator('.trade-colors').boundingBox())!;
    expect(staff.y + staff.height).toBeLessThan(colors.y);
    await expect(panel.locator('.trade-colors')).not.toHaveAttribute('open', '');
    await panel.getByLabel('选择施工人员', { exact: true }).selectOption('worker-ui');
    await panel.locator('.trade-colors summary').click();
    await panel.getByLabel('自定义颜色', { exact: true }).fill('#597d67');
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await state(page)).trades[1].staffIds).toEqual(['worker-ui']);
    expect((await state(page)).trades[1].color).toBe('#597d67');
    await expect(page.locator('.toast')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/chunmo-refined-${width}.png`, fullPage: true });
  });
for (const width of [1440, 320])
  test(`unified calendar ${width}px: keyboard, leap day, bounds and no native date controls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
    await boot(page);
    await restore(page);
    await closeToast(page);
    await expect(page.locator('input[type=date],input[type=month]')).toHaveCount(0);
    await page.getByRole('button', { name: '选择定位日期', exact: true }).click();
    let calendar = page.getByRole('dialog', { name: '定位日期日历', exact: true });
    await expect(
      calendar.getByRole('button', { name: '选择 2026-10-21', exact: true }),
    ).toBeDisabled();
    await expect(
      calendar.getByRole('button', { name: '选择 2026-10-23', exact: true }),
    ).toHaveAttribute('aria-current', 'date');
    const bounds = (await calendar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
    await calendar.getByRole('button', { name: '清除日期', exact: true }).click();
    await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '选择定位日期', exact: true }).click();
    calendar = page.getByRole('dialog', { name: '定位日期日历', exact: true });
    await calendar.getByLabel('跳转年份', { exact: true }).selectOption('2028');
    await calendar.getByLabel('跳转月份', { exact: true }).selectOption('02');
    await calendar.getByRole('button', { name: '选择 2028-02-28', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(
      calendar.getByRole('button', { name: '选择 2028-02-29', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('2028-02-29');
    await page.getByRole('button', { name: '选择定位日期', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(calendar).not.toBeVisible();
    await expect(page.getByRole('button', { name: '选择定位日期', exact: true })).toBeFocused();
    await page.getByLabel('定位日期', { exact: true }).fill('2031-10-24');
    expect(
      await page
        .getByLabel('定位日期', { exact: true })
        .evaluate((e) => (e as HTMLInputElement).checkValidity()),
    ).toBe(false);
    await page.getByRole('button', { name: '选择定位日期', exact: true }).click();
    calendar = page.getByRole('dialog', { name: '定位日期日历', exact: true });
    await expect(
      calendar.getByRole('button', { name: '选择 2031-10-24', exact: true }),
    ).toBeDisabled();
    await calendar.getByRole('button', { name: '今天', exact: true }).click();
    await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('2026-10-23');
  });
