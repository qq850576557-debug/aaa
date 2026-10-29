import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { boot, fixture, restore, state, closeToast } from './helpers';
test.use({ timezoneId: 'Asia/Shanghai' });
for (const width of [1440, 1280, 390])
  test(`agenda ${width}: stable empty/full/long cards, scoped identity and independent procurement`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-29T10:00:00Z'));
    await boot(page);
    const d = fixture(),
      originalPurchases = structuredClone(d.purchases),
      memo = d.notes.find((n) => n.kind === '项目备忘')!;
    const boxes: unknown[] = [];
    let purchaseSnapshot = originalPurchases;
    for (const count of [0, 1, 8]) {
      d.notes = Array.from({ length: count }, (_, i) => [
        {
          ...memo,
          id: 'today-' + i,
          kind: '施工安排' as const,
          title: '今日现场核验' + i,
          date: '2026-10-29',
          pinned: false,
          content: '检查成品保护与现场进度，逐项确认施工要求。',
        },
        {
          ...memo,
          id: 'tomorrow-' + i,
          kind: '施工安排' as const,
          title: '明日现场安排' + i,
          date: '2026-10-30',
          pinned: false,
          content: '提前准备工具，现场复核后记录结果。',
        },
        { ...memo, id: 'memo-' + i, title: '长期项目备忘' + i, date: '2026-10-29', pinned: false },
      ]).flat();
      await restore(page, d);
      await closeToast(page);
      if (!count) purchaseSnapshot = (await state(page)).purchases;
      const cards = page.locator('.agenda-brief .brief-panel');
      await expect(cards).toHaveCount(3);
      const geometry = await cards.evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect(),
            h = e.querySelector('.brief-heading')!.getBoundingClientRect();
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            heading: Math.round(h.y - r.y),
          };
        }),
      );
      expect(new Set(geometry.map((x) => x.h)).size).toBe(1);
      expect(geometry[0].h).toBeGreaterThan(180);
      expect(geometry[0].h).toBeLessThan(270);
      if (boxes.length) expect(geometry).toEqual(boxes[0]);
      boxes.push(geometry);
      const today = page.getByTestId('today-panel'),
        tomorrow = page.getByTestId('tomorrow-panel'),
        memos = page.getByTestId('memo-panel');
      if (!count) {
        await expect(today).toContainText('今日暂无待办事项');
        await expect(tomorrow).toContainText('明日暂无安排');
      } else {
        await expect(today).toContainText('今日现场核验0');
        await expect(tomorrow).toContainText('明日现场安排0');
        await expect(memos).toContainText('长期项目备忘0');
      }
      await expect(page.locator('.agenda-brief')).not.toContainText(originalPurchases[0].name);
      await expect(page.locator('.agenda-brief')).not.toContainText(d.projects[0].name);
      expect((await state(page)).purchases).toEqual(purchaseSnapshot);
      if (count === 8) {
        await today.getByRole('button', { name: '展开今日事项', exact: true }).click();
        expect(
          await today.locator('.brief-content').evaluate((e) => e.scrollHeight > e.clientHeight),
        ).toBe(true);
        await today.locator('[data-note-id="today-7"] .note-main').click();
        await expect(page.getByRole('dialog', { name: '编辑每日事项', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
        await today.getByRole('button', { name: '收起今日事项', exact: true }).click();
        expect((await state(page)).notes).toHaveLength(24);
      }
      await mkdir('docs/screenshots/home-agenda', { recursive: true });
      await page.screenshot({
        path: `docs/screenshots/home-agenda/home-${count === 0 ? 'empty' : count === 1 ? 'filled' : 'long'}-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await expect(page.locator('.purchase-list')).toContainText(originalPurchases[0].name);
    await expect(page.locator('.purchase-list')).not.toContainText(d.projects[0].name);
    await expect(page.locator('.project-context')).toContainText(d.projects[0].name);
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    await expect(page.locator('.reminder-columns')).toContainText(originalPurchases[0].name);
    await expect(page.locator('.reminder-columns')).toContainText(d.projects[0].name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
test('tomorrow CRUD, confirmation, completion and year-end rollover retain one record and project isolation', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-12-31T15:59:00Z') });
  await boot(page);
  const d = fixture();
  d.notes = [];
  d.projects.push({ ...d.projects[0], id: 'other', name: '另一个工地' });
  await restore(page, d);
  await closeToast(page);
  const originalPurchases = (await state(page)).purchases;
  const tomorrow = page.getByTestId('tomorrow-panel'),
    today = page.getByTestId('today-panel');
  await tomorrow.getByRole('button', { name: '添加明日事项', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建每日事项', exact: true });
  await expect(dialog.getByLabel('计划日期', { exact: true })).toHaveValue('2027-01-01');
  await dialog.getByLabel('事项标题', { exact: true }).fill('元旦现场复核');
  await dialog.getByLabel('详细备注（可选）', { exact: true }).fill('现场确认工艺');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(tomorrow).toContainText('元旦现场复核');
  const saved = (await state(page)).notes[0];
  expect(saved.projectId).toBe(d.projects[0].id);
  expect((await state(page)).purchases).toEqual(originalPurchases);
  await tomorrow.locator('.note-main').click();
  dialog = page.getByRole('dialog', { name: '编辑每日事项', exact: true });
  await dialog.getByLabel('事项标题', { exact: true }).fill('元旦施工复核');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await tomorrow.getByRole('button', { name: '完成元旦施工复核', exact: true }).click();
  await expect(tomorrow.locator('.note-card')).toHaveClass(/done/);
  await tomorrow.getByRole('button', { name: '标记未完成元旦施工复核', exact: true }).click();
  await tomorrow.locator('.note-main').click();
  await page.getByLabel('计划日期', { exact: true }).fill('2026-12-31');
  await page
    .getByRole('dialog', { name: '编辑每日事项', exact: true })
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(today).toContainText('元旦施工复核');
  await expect(tomorrow).not.toContainText('元旦施工复核');
  await today.locator('.note-main').click();
  await page.getByLabel('计划日期', { exact: true }).fill('2027-01-01');
  await page
    .getByRole('dialog', { name: '编辑每日事项', exact: true })
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(tomorrow).toContainText('元旦施工复核');
  expect((await state(page)).notes).toHaveLength(1);
  expect((await state(page)).notes[0].id).toBe(saved.id);
  await page.clock.fastForward(70000);
  await expect(today).toContainText('元旦施工复核');
  await expect(tomorrow).not.toContainText('元旦施工复核');
  expect((await state(page)).notes).toHaveLength(1);
  expect((await state(page)).notes[0].id).toBe(saved.id);
  expect((await state(page)).notes[0].date).toBe('2027-01-01');
  await page.reload();
  await expect(today).toContainText('元旦施工复核');
  await page.getByRole('button', { name: '删除事项元旦施工复核', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await state(page)).notes).toHaveLength(1);
  await page.getByRole('button', { name: '删除事项元旦施工复核', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(today).toContainText('今日暂无待办事项');
  expect((await state(page)).notes).toHaveLength(0);
});
