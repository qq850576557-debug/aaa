import { editTask } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { boot, closeToast, fixture, restore, state } from './helpers';
import { id } from '../src/lib/model';
async function schedule(page: Page) {
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await closeToast(page);
  await page.locator('.schedule-section').scrollIntoViewIfNeeded();
}
async function dragBar(page: Page, name: string, delta: number) {
  const bar = page.getByTestId('task-bar').filter({ hasText: name }).first();
  await bar.scrollIntoViewIfNeeded();
  const r = await bar.boundingBox();
  await page.mouse.move(r!.x + 25, r!.y + 17);
  await page.mouse.down();
  await page.mouse.move(r!.x + 25 + delta * 56, r!.y + 17, { steps: 12 });
  await page.mouse.up();
}
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
});

test('dirty form protection, anchored quick create, real calendar and duration stay in sync', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await schedule(page);
  const cell = page.locator('.trade-row').first().locator('[data-date="2026-10-27"]');
  const point = await cell.boundingBox();
  await cell.dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  const created = (await state(page)).tasks.find(
    (t) => t.id !== 't-first' && t.start === '2026-10-27',
  )!;
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: created.name }).last());
  let modal = page.getByRole('dialog');
  await modal.getByLabel('任务名称', { exact: true }).fill('第二段拆改');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '第二段拆改' }));
  modal = page.getByRole('dialog', { name: '编辑施工任务', exact: true });
  await expect(modal).toHaveClass(/anchored/);
  const rect = await modal.boundingBox();
  expect(rect!.x).toBeGreaterThan(12);
  expect(rect!.x).toBeLessThan(1440);
  expect(point!.y).toBeGreaterThan(0);
  await modal.getByLabel('持续天数', { exact: true }).fill('5');
  await expect(modal.getByLabel('结束日期', { exact: true })).toHaveValue('2026-10-31');
  await modal.getByRole('button', { name: '选择开始日期', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: '开始日期日历', exact: true });
  await expect(calendar).toBeVisible();
  await calendar.getByRole('button', { name: '下个月', exact: true }).click();
  await calendar.getByRole('button', { name: '选择 2026-11-02', exact: true }).click();
  await expect(modal.getByLabel('开始日期', { exact: true })).toHaveValue('2026-11-02');
  await expect(modal.getByLabel('结束日期', { exact: true })).toHaveValue('2026-11-06');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '放弃未保存的修改？' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).last().click();
  await expect(modal).toBeVisible();
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  expect((await state(page)).tasks).toHaveLength(4);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '现场保护与拆改' }));
  await expect(page.getByRole('heading', { name: '编辑施工任务' })).toBeVisible();
  modal = page.getByRole('dialog');
  await modal.getByLabel('任务名称', { exact: true }).fill('未保存的名称');
  await modal.getByRole('button', { name: '复制', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('请先保存当前修改，再复制');
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('linked segments merge in view only; dates, references and undo preserve original records', async ({
  page,
}) => {
  const d = fixture(),
    a = d.tasks[0];
  a.groupId = a.id;
  const b = { ...a, id: 'segment-2', start: '2026-10-28', end: '2026-10-29' };
  d.tasks.push(b);
  d.purchases[0].taskId = a.id;
  d.notes[0].taskId = a.id;
  await boot(page);
  await restore(page, d);
  await schedule(page);
  await dragBar(page, '现场保护与拆改', 0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '现场保护与拆改' }).first());
  expect((await state(page)).tasks).toHaveLength(4);
  await page.getByRole('button', { name: '关闭浮窗' }).click(); // no-op opens edit but must not merge
  const second = page.getByTestId('task-bar').filter({ hasText: '现场保护与拆改' }).nth(1);
  await second.scrollIntoViewIfNeeded();
  let r = await second.boundingBox();
  await page.mouse.move(r!.x + 25, r!.y + 17);
  await page.mouse.down();
  await page.mouse.move(r!.x + 25 - 2 * 56, r!.y + 17, { steps: 12 });
  await page.mouse.up();
  // Display-only merging does not retire or remap either source record.
  const earlier = page.getByRole('dialog', {
    name: '当前工序已提前，是否同步提前后续工序？',
    exact: true,
  });
  await expect(earlier).toBeVisible();
  expect((await state(page)).tasks.find((t) => t.id === b.id)?.start).toBe(b.start);
  await earlier.getByRole('button', { name: '不调整', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === b.id)?.start)
    .toBe('2026-10-26');
  let saved = await state(page);
  expect(saved.tasks).toHaveLength(4);
  await expect(page.locator('.trade-row').first().getByTestId('task-bar')).toHaveCount(1);
  expect(saved.tasks.find((t) => t.id === 'segment-2')?.start).toBe('2026-10-26');
  expect(saved.tasks.find((t) => t.id === 'segment-2')?.end).toBe('2026-10-27');
  expect(saved.purchases[0].taskId).toBe(a.id);
  expect(saved.notes[0].taskId).toBe(a.id);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  expect((await state(page)).purchases[0].taskId).toBe(a.id);
  expect((await state(page)).tasks.find((t) => t.id === b.id)?.start).toBe(b.start);
});

test('reschedule preview offers atomic cancel/current-only/propagation, preserves overlap and is undoable', async ({
  page,
}) => {
  const d = fixture();
  const first = d.tasks[0],
    next = d.tasks[1];
  next.dependsOn = [first.id];
  d.tasks.push({
    ...next,
    id: 'overlap',
    tradeId: d.trades[4].id,
    name: '独立交叉施工',
    start: '2026-10-24',
    end: '2026-10-30',
    dependsOn: [],
  });
  await boot(page);
  await restore(page, d);
  await schedule(page);
  async function extend() {
    await editTask(page, page.getByTestId('task-bar').filter({ hasText: '现场保护与拆改' }));
    const m = page.getByRole('dialog');
    await m.getByLabel('结束日期', { exact: true }).fill('2026-10-28');
    await m.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: '是否顺延后续工期？' })).toBeVisible();
  }
  await extend();
  expect((await state(page)).tasks[0].end).toBe('2026-10-25');
  await page.getByRole('button', { name: '取消本次操作' }).click();
  expect((await state(page)).tasks[0].end).toBe('2026-10-25');
  await extend();
  await page.getByRole('button', { name: '仅调整当前工序' }).click();
  await expect.poll(async () => (await state(page)).tasks[0].end).toBe('2026-10-28');
  expect((await state(page)).tasks[1].start).toBe('2026-10-26');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await extend();
  await page.getByRole('button', { name: '顺延后续工期', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks[1].start).toBe('2026-10-29');
  expect((await state(page)).tasks.find((t) => t.id === 'overlap')?.start).toBe('2026-10-24');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).tasks[1].end).toBe('2026-11-08');
});

test('trade drag sorting has a drop line, inserts inline, and live color persists without changing dates', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await schedule(page);
  const before = (await state(page)).tasks;
  await expect(
    page
      .locator('.schedule-section>.section-heading')
      .getByRole('button', { name: '工种', exact: true }),
  ).toHaveCount(0);
  const handle = page.getByRole('button', { name: '拖动工种防水与闭水试验', exact: true }),
    target = page.locator('.trade-row').first();
  const sourceBox = await handle.boundingBox(),
    targetBox = await target.boundingBox();
  await page.mouse.move(sourceBox!.x + 8, sourceBox!.y + 10);
  await page.mouse.down();
  await page.mouse.move(sourceBox!.x + 14, sourceBox!.y + 15, { steps: 4 });
  await page.mouse.move(targetBox!.x + 90, targetBox!.y + 12, { steps: 15 });
  await expect(page.locator('.drop-before')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.trade-title').first()).toContainText('防水与闭水试验');
  expect((await state(page)).tasks).toEqual(before);
  await page
    .getByRole('button', { name: '在水电改造前新增工种', exact: true })
    .click({ force: true });
  let m = page.getByRole('dialog');
  await m.getByLabel('工种名称', { exact: true }).fill('成品保护');
  await m.getByRole('button', { name: '保存', exact: true }).click();
  const names = (await state(page)).trades.sort((a, b) => a.order - b.order).map((t) => t.name);
  expect(names.indexOf('成品保护') + 1).toBe(names.indexOf('水电改造'));
  await page.getByRole('button', { name: '设置水电改造颜色', exact: true }).click();
  m = page.getByRole('dialog');
  await expect(m.locator('.w-color-wheel')).toBeVisible();
  await m.getByLabel('自定义颜色', { exact: true }).fill('#244e42');
  await expect(page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' })).toHaveCSS(
    'border-color',
    'rgb(36, 78, 66)',
  );
  await m.getByLabel('明度', { exact: true }).fill('60');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).trades.find((t) => t.name === '水电改造')?.color).not.toBe('#648b9c');
  expect((await state(page)).tasks).toEqual(before);
});

test('legacy archived and completed history is retained, zero metrics say 暂无 and cards filter exact categories', async ({
  page,
}) => {
  await boot(page);
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('暂无');
  const d = fixture();
  d.projects[0].archived = true;
  await restore(page, d);
  await page.getByRole('button', { name: '已完工项目', exact: true }).first().click();
  await expect(page.locator('.current-project-name')).toHaveText(d.projects[0].name);
  expect((await state(page)).tasks).toHaveLength(3);
  await page.getByRole('button', { name: '恢复施工中' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects[0].archived).toBe(false);
  await page.locator('.stat-card').filter({ hasText: '未来 15 天采购' }).click();
  await expect(page.locator('.project-filter')).toContainText('未来 15 天采购');
  await expect(page.locator('.reminder-columns .panel:visible')).toHaveCount(1);
  await expect(page.locator('.panel:visible .purchase-card')).toContainText('电线及线管');
});

test('monthly 2x export produces independent titled PNGs and top success feedback expires', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await closeToast(page);
  await page.getByRole('button', { name: '导出施工工期长图', exact: true }).click();
  let m = page.getByRole('dialog');
  await m.getByRole('combobox', { name: '导出方式', exact: true }).selectOption('month');
  await m.getByRole('button', { name: '生成并导出' }).click();
  await expect(m.locator('.export-files button')).toHaveCount(3);
  const download = page.waitForEvent('download');
  await m.locator('.export-files button').first().click();
  const file = await download,
    buf = await readFile((await file.path())!);
  expect(file.suggestedFilename()).toContain('2026-10');
  expect(buf.readUInt32BE(16)).toBe(2000);
  await file.saveAs('test-results/monthly-october.png');
  await m.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.toast-stack')).toContainText('月度长图已导出');
  const toastBox = await page.locator('.toast-stack').boundingBox();
  expect(toastBox!.y).toBeLessThan(120);
  await expect(page.locator('.toast-stack .toast')).toHaveCount(0, { timeout: 5000 });
});

test('today, memo and purchase panels precede timeline, completion and project switching remain isolated', async ({
  page,
}) => {
  const d = fixture();
  const p2 = { ...d.projects[0], id: id(), name: '另一项目' };
  d.projects.push(p2);
  await boot(page);
  await restore(page, d);
  await schedule(page);
  const cards = await page.locator('.workspace-brief').boundingBox(),
    gantt = await page.locator('.schedule-section').boundingBox();
  expect(cards!.y).toBeLessThan(gantt!.y);
  await page.getByRole('button', { name: '完成材料与施工注意事项', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).notes.find((n) => n.kind === '项目备忘')?.done)
    .toBe(true);
  await page.locator(`[data-project-id="${p2.id}"]`).click();
  await expect(
    page.getByRole('button', { name: '标记未完成材料与施工注意事项', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.project-alerts')).not.toContainText('电线及线管');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('scaled timeline uses measured date columns and keeps sticky dates aligned', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await schedule(page);
  await page.evaluate(() => {
    document.body.style.zoom = '1.25';
  });
  const scroller = page.getByTestId('gantt-scroll');
  await scroller.evaluate((e) => (e.scrollLeft = 120));
  const water = page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' });
  await water.scrollIntoViewIfNeeded();
  const r = await water.boundingBox(),
    box = await scroller.boundingBox();
  const dayWidth = await page
    .locator('.date-cell')
    .first()
    .evaluate((e) => e.getBoundingClientRect().width);
  const x = Math.max(r!.x + 25, box!.x + 244 * 1.25 + 18);
  await page.mouse.move(x, r!.y + 17);
  await page.mouse.down();
  await page.mouse.move(x + 2 * dayWidth, r!.y + 17, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-28');
  const head = await page
      .getByRole('button', { name: '查看 2026-10-28 事项', exact: true })
      .boundingBox(),
    cell = await page
      .locator('.trade-row')
      .first()
      .locator('[data-date="2026-10-28"]')
      .boundingBox();
  expect(Math.abs(head!.x - cell!.x)).toBeLessThan(1);
  expect(
    await page
      .locator('.trade-title>button:not(.drag-handle):not(.trade-color)')
      .first()
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(14);
});
