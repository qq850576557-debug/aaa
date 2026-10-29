import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { boot, restore, fixture, state, closeToast } from './helpers';

test.use({ timezoneId: 'Asia/Shanghai' });
const screenshots =
  process.env.CHUNMO_UI_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/ui-hierarchy';
for (const width of [1440, 1280, 390, 320])
  test(`UI hierarchy ${width}: no banner, grouped cards, procurement actions and personnel colors`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-29T04:00:00+08:00'));
    await boot(page);
    const d = fixture();
    d.dictionaries = [
      { id: 'water', kind: 'trade', label: '水电改造', active: true, order: 0 },
      { id: 'wood', kind: 'trade', label: '木工吊顶', active: true, order: 1 },
    ];
    d.people = [
      {
        id: 'worker-water',
        name: '陈师傅',
        role: '施工人员',
        trade: '',
        tradeIds: ['water'],
        notes: '进场前核对施工图。',
        active: true,
      },
      {
        id: 'worker-wood',
        name: '林师傅',
        role: '施工人员',
        trade: '',
        tradeIds: ['wood'],
        notes: '',
        active: true,
      },
    ];
    await restore(page, d);
    await closeToast(page);
    await expect(page.locator('.save-state')).toContainText('已保存');
    const original = await state(page);
    await expect(page.locator('.workspace-status-group,.local-notice')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '事项与备忘', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '备份数据', exact: true })).toBeVisible();
    await expect(page.locator('.ui-module-group')).toHaveCount(2);
    for (const group of await page.locator('.ui-module-group').all()) {
      const style = await group.evaluate((e) => {
        const s = getComputedStyle(e);
        return {
          radius: parseFloat(s.borderRadius),
          color: s.backgroundColor,
          parent: getComputedStyle(e.parentElement!).backgroundColor,
        };
      });
      expect(style.radius).toBeGreaterThanOrEqual(12);
      expect(style.color).not.toBe(style.parent);
    }
    const heading = await page.locator('.page-heading').boundingBox(),
      main = await page.locator('main').boundingBox();
    expect(heading!.y - main!.y).toBeLessThan(width <= 950 ? 60 : 25);
    const cards = await page.locator('.agenda-brief .brief-panel').evaluateAll((es) =>
      es.map((e) => ({
        w: e.getBoundingClientRect().width,
        h: e.getBoundingClientRect().height,
      })),
    );
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((x) => x.h)).size).toBe(1);
    expect(Math.max(...cards.map((x) => x.w)) - Math.min(...cards.map((x) => x.w))).toBeLessThan(1);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: `${screenshots}/home-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });

    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    const row = page.locator('.purchase-card').first(),
      group = row.getByRole('group');
    await expect(group).toHaveAccessibleName('采购操作：电线及线管');
    const controls = await group.locator(':scope > button,:scope > select').evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, h: r.height };
      }),
    );
    expect(new Set(controls.map((x) => x.h)).size).toBe(1);
    for (let i = 0; i < controls.length; i++) {
      expect(controls[i].right).toBeLessThanOrEqual(width);
      for (let j = 0; j < i; j++)
        expect(
          controls[i].x >= controls[j].right ||
            controls[j].x >= controls[i].right ||
            controls[i].y >= controls[j].bottom ||
            controls[j].y >= controls[i].bottom,
        ).toBe(true);
    }
    expect(
      await group
        .locator('.purchase-complete')
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    ).not.toBe(
      await group.locator('.purchase-edit').evaluate((e) => getComputedStyle(e).backgroundColor),
    );
    await page.screenshot({
      path: `${screenshots}/purchases-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    const worker = page.locator('[data-person-id="worker-water"]');
    await worker.getByRole('button', { name: '打开人员档案：陈师傅', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑人员档案', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '工种配色', exact: true }).click();
    const colors = page.getByRole('dialog', { name: '工种卡片配色', exact: true });
    await colors.getByLabel('卡片配色工种', { exact: true }).selectOption('id:water');
    await colors.getByLabel('自定义颜色', { exact: true }).fill('invalid');
    await expect(colors.getByRole('button', { name: '保存配色', exact: true })).toBeDisabled();
    await colors.getByLabel('自定义颜色', { exact: true }).fill('#6b91ac');
    const colorBounds = (await colors.boundingBox())!;
    expect(colorBounds.x).toBeGreaterThanOrEqual(0);
    expect(colorBounds.x + colorBounds.width).toBeLessThanOrEqual(width);
    expect(
      await colors.locator('.modal-body').evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `${screenshots}/people-colors-${width}.png`,
      animations: 'disabled',
    });
    await colors.getByRole('button', { name: '保存配色', exact: true }).click();
    expect(
      await worker.evaluate((e) => getComputedStyle(e).getPropertyValue('--person-color').trim()),
    ).toBe('#6b91ac');
    expect(
      await page
        .locator('[data-person-id="worker-wood"]')
        .evaluate((e) => getComputedStyle(e).getPropertyValue('--person-color').trim()),
    ).not.toBe('#6b91ac');
    expect(await state(page)).toEqual(original);
    await page.reload();
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    expect(
      await worker.evaluate((e) => getComputedStyle(e).getPropertyValue('--person-color').trim()),
    ).toBe('#6b91ac');
    expect(await state(page)).toEqual(original);
    await page.screenshot({
      path: `${screenshots}/people-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

test('legacy notes remain editable and project isolated inside the board, no automatic conversion', async ({
  page,
}) => {
  await boot(page);
  const d = fixture();
  d.projects.push({ ...d.projects[0], id: 'other-site', name: '第二工地' });
  d.notes.push({
    ...d.notes[0],
    id: 'future-note',
    title: '明年现场复核',
    date: '2027-02-01',
    reminder: '',
    pinned: false,
  });
  await restore(page, d);
  const original = await state(page);
  await page
    .getByTestId('memo-panel')
    .getByRole('button', { name: '查看日常记录', exact: true })
    .click();
  await expect(page.locator('.daily-records')).toHaveAttribute('open', '');
  await expect(page.locator('.notes-grid .note-card')).toHaveCount(3);
  await page.locator('[data-note-id="future-note"] .note-main').click();
  await page.getByLabel('事项标题', { exact: true }).fill('明年现场复核完成尺寸');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).notes.find((n) => n.id === 'future-note')?.title)
    .toBe('明年现场复核完成尺寸');
  await page.getByLabel('日常记录工地', { exact: true }).selectOption('other-site');
  await expect(page.locator('.notes-grid .note-card')).toHaveCount(0);
  await page.getByLabel('日常记录工地', { exact: true }).selectOption(d.projects[0].id);
  await expect(page.locator('.notes-grid .note-card')).toHaveCount(3);
  expect((await state(page)).notes.find((n) => n.id === 'future-note')?.date).toBe('2027-02-01');
  expect((await state(page)).purchases).toEqual(original.purchases);
  expect((await state(page)).tasks).toEqual(original.tasks);
  await page.reload();
  await page.getByRole('button', { name: '记录状态看板', exact: true }).click();
  await page.locator('.daily-records > summary').click();
  await expect(page.locator('.notes-grid')).toContainText('明年现场复核完成尺寸');
});
