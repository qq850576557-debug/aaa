import { test, expect } from '@playwright/test';
import { boot, restore, fixture, state, closeToast } from './helpers';

for (const width of [1440, 1280, 390, 320])
  test(`compact purchases ${width}: aligned controls, readable cards, filters, edit and confirmed deletion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await boot(page);
    const data = fixture();
    data.purchases.push({
      ...data.purchases[0],
      id: 'completed-purchase',
      name: '已购开关',
      status: '已完成',
    });
    await restore(page, data);
    await closeToast(page);
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: '采购清单工具栏' });
    const search = toolbar.getByRole('textbox', { name: '搜索采购记录' });
    const filter = toolbar.getByLabel('采购记录筛选', { exact: true });
    const toggle = toolbar.getByRole('button', { name: '只看未完成', exact: true });
    const cards = page.locator('.purchase-list .purchase-card');
    await expect(cards).toHaveCount(2);
    await expect(page.getByRole('button', { name: '采购历史', exact: true })).toHaveCount(0);
    await expect(page.locator('.purchase-trace')).toHaveCount(0);
    const controls = [toolbar.getByRole('heading'), search, filter, toggle];
    const rects = await Promise.all(controls.map((c) => c.boundingBox()));
    const icon = await toolbar.locator('.search-field > svg').boundingBox();
    expect(icon!.x + icon!.width + 4).toBeLessThanOrEqual(rects[1]!.x);
    if (width >= 1280) {
      for (let i = 1; i < rects.length; i++) {
        expect(rects[i]!.x).toBeGreaterThan(rects[i - 1]!.x);
        expect(
          Math.abs(rects[i]!.y + rects[i]!.height / 2 - rects[i - 1]!.y - rects[i - 1]!.height / 2),
        ).toBeLessThan(3);
      }
      expect(rects[1]!.width).toBeLessThanOrEqual(210);
    }
    const beforeToggle = await toggle.evaluate((e) => getComputedStyle(e).backgroundColor);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await toggle.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(
      beforeToggle,
    );
    await expect(cards).toHaveCount(1);
    await toggle.click();
    await filter.selectOption('已完成');
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('已购开关');
    await filter.selectOption('全部');
    await search.fill('张师傅');
    await expect(cards).toHaveCount(2);
    await search.fill('电线');
    await expect(cards).toHaveCount(1);
    const card = cards.first();
    const status = card.getByLabel('采购状态电线及线管', { exact: true });
    const remove = card.getByRole('button', { name: '删除采购电线及线管', exact: true });
    const r = await status.boundingBox(),
      d = await remove.boundingBox();
    expect(Math.abs(r!.y - d!.y)).toBeLessThan(2);
    expect(d!.x).toBeGreaterThan(r!.x + r!.width);
    expect(await remove.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
      'rgb(250, 238, 235)',
    );
    if (width < 700) expect(d!.height).toBeGreaterThanOrEqual(40);
    const layout = await card.evaluate((e) => ({
      font: parseFloat(getComputedStyle(e.querySelector('strong')!).fontSize),
      overflow: document.documentElement.scrollWidth > innerWidth,
      height: e.getBoundingClientRect().height,
    }));
    expect(layout.font).toBeGreaterThanOrEqual(14);
    expect(layout.overflow).toBe(false);
    expect(layout.height).toBeLessThan(300);
    await status.selectOption('已下单');
    await expect.poll(async () => (await state(page)).purchases[0].status).toBe('已下单');
    await card.getByRole('button', { name: '编辑采购电线及线管', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('采购内容 / 事项标题', { exact: true }).fill('更新电线');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(cards).toContainText('更新电线');
    await cards.getByRole('button', { name: '删除采购更新电线', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    expect((await state(page)).purchases).toHaveLength(2);
    await cards.getByRole('button', { name: '删除采购更新电线', exact: true }).click();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await expect.poll(async () => (await state(page)).purchases.length).toBe(1);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect((await state(page)).purchases.map((p) => p.name)).toEqual(['已购开关']);
  });
