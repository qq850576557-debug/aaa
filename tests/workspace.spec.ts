import { displayedTradeRGB } from './helpers';
import { editTask } from './helpers';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { emptyData } from '../src/lib/model';

import { state, boot, restore, closeToast } from './helpers';
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
});

test('create projects and tasks through validated modals; persistence and independent projects', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await expect(page.getByText('创建第一个项目', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('项目名称', { exact: true }).fill('跨年新居');
  await modal.getByLabel('计划开工日期', { exact: true }).fill('2026-12-28');
  await modal.getByLabel('计划完工日期', { exact: true }).fill('2027-01-20');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.current-project-name')).toHaveText('跨年新居');
  await expect(page.locator('.trade-row')).toHaveCount(8);
  await page.getByRole('button', { name: '施工任务', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('任务名称', { exact: true }).fill('跨年拆改');
  await modal.getByLabel('开始日期', { exact: true }).fill('2026-12-31');
  await modal.getByLabel('结束日期', { exact: true }).fill('2027-01-02');
  await expect(modal.getByText('3 天', { exact: true })).toBeVisible();
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByLabel('定位日期', { exact: true }).fill('2026-12-31');
  await expect(page.getByTestId('task-bar')).toHaveCount(1);
  await expect.poll(async () => (await state(page))?.tasks.length).toBe(1);
  await page.reload();
  await page.getByLabel('定位日期', { exact: true }).fill('2026-12-31');
  await expect(page.getByTestId('task-bar')).toHaveCount(1);
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('项目名称', { exact: true }).fill('另一个家');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('task-bar')).toHaveCount(0);
  await page.getByRole('button', { name: '切换项目跨年新居', exact: true }).click();
  await page.getByLabel('定位日期', { exact: true }).fill('2026-12-31');
  await expect(page.getByTestId('task-bar')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('date click, double click, range select, move and both resize handles have no event conflicts', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await closeToast(page);
  const cells = page.locator('.trade-row').first().locator('.track-cell');
  const cell = cells.nth(5);
  await cell.click();
  await expect(page.getByRole('heading', { name: '2026-10-27 · 每日事项' })).toBeVisible();
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  await cell.dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  const quick = (await state(page)).tasks.find((t) => t.start === '2026-10-27')!;
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: quick.name }).last());
  let modal = page.getByRole('dialog');
  await modal.getByLabel('任务名称', { exact: true }).fill('第二段拆改');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  const from = await cells.nth(8).boundingBox(),
    to = await cells.nth(10).boundingBox();
  await page.mouse.move(from!.x + 22, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + 22, to!.y + to!.height / 2, { steps: 12 });
  await page.mouse.up();
  modal = page.getByRole('dialog');
  await expect(modal.getByLabel('开始日期', { exact: true })).toHaveValue('2026-10-30');
  await expect(modal.getByLabel('结束日期', { exact: true })).toHaveValue('2026-11-01');
  await modal.getByLabel('任务名称', { exact: true }).fill('第三段拆改');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  const water = page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' });
  await water.hover();
  let box = await water.boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + 15);
  await page.mouse.down();
  await page.mouse.move(box!.x + 142, box!.y + 15, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-28');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await water.getByTestId('resize-end').scrollIntoViewIfNeeded();
  let handle = await water.getByTestId('resize-end').boundingBox();
  await page.mouse.move(handle!.x + 4, handle!.y + 14);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 60, handle!.y + 14, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.end)
    .toBe('2026-11-08');
  await water.getByTestId('resize-start').scrollIntoViewIfNeeded();
  handle = await water.getByTestId('resize-start').boundingBox();
  await page.mouse.move(handle!.x + 4, handle!.y + 14);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 60, handle!.y + 14, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-29');
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await expect(page.locator('.purchase-row')).toContainText('2026-10-23 前采购');
});

test('continuous creation, accessible ordering, color wheel and default colors', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByRole('button', { name: '拖动工种水电改造', exact: true }).press('Alt+ArrowUp');
  await expect(page.locator('.trade-title').first()).toContainText('水电改造');
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.locator('.trade-colors > summary').click();
  await expect(modal.locator('.w-color-wheel')).toBeVisible();
  await modal.getByLabel('自定义颜色', { exact: true }).fill('#244e42');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' })).toHaveCSS(
    'border-color',
    await displayedTradeRGB(page, '#244e42'),
  );
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
  await page.getByRole('dialog').locator('.trade-colors > summary').click();
  await page.getByRole('button', { name: '恢复默认颜色' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '施工任务', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('任务名称', { exact: true }).fill('连续任务 A');
  await modal.getByLabel('开始日期', { exact: true }).fill('2026-11-01');
  await modal.getByLabel('结束日期', { exact: true }).fill('2026-11-03');
  await modal.getByLabel('保存后继续创建下一段任务').check();
  await modal.getByRole('button', { name: '保存并继续' }).click();
  await expect(modal.getByLabel('开始日期', { exact: true })).toHaveValue('2026-11-04');
  await modal.getByLabel('任务名称', { exact: true }).fill('连续任务 B');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.filter((t) => t.name.startsWith('连续任务')).length)
    .toBe(2);
});

test('notes, completion, search, pin, project copy/completion/recovery and confirmed deletion', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page.locator('.daily-records > summary').click();
  await page.getByRole('button', { name: '项目备忘', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('备忘标题', { exact: true }).fill('核对门洞尺寸');
  await modal.getByLabel('详细备注（可选）', { exact: true }).fill('小陈负责现场复核');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '置顶核对门洞尺寸', exact: true }).click();
  await page.getByRole('button', { name: '完成核对门洞尺寸', exact: true }).click();
  await page.getByLabel('只看未完成').check();
  await expect(
    page.getByRole('button', { name: '标记未完成核对门洞尺寸', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('只看未完成').uncheck();
  await page.getByPlaceholder('搜索标题、内容或负责人…').fill('小陈');
  await expect(page.locator('.notes-grid .note-card')).toHaveCount(1);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByRole('button', { name: '编辑当前项目' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '复制', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects.length).toBe(2);
  await expect(page.locator('.project-card.chosen')).toHaveCount(1);
  await page.getByRole('button', { name: '标记完工', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).projects.filter((p) => p.status === '已完工').length)
    .toBe(1);
  await page.getByRole('button', { name: '恢复施工中', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).projects.filter((p) => p.status === '已完工').length)
    .toBe(0);
  await page.getByRole('button', { name: '编辑当前项目' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).last().click();
  await expect.poll(async () => (await state(page)).projects.length).toBe(2);
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects.length).toBe(1);
});

test('JSON validation, overwrite cancellation and complete PNG beyond viewport', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '数据与备份' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.getByRole('alert')).toContainText('备份校验失败');
  expect((await state(page)).projects).toHaveLength(1);
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整 JSON 备份' }).click();
  const backup = await backupDownload;
  expect(JSON.parse(await readFile((await backup.path())!, 'utf8')).tasks).toHaveLength(3);
  await page.locator('input[type=file]').setInputFiles({
    name: 'empty.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(emptyData())),
  });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await state(page)).projects).toHaveLength(1);
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  const imageDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出施工工期长图', exact: true }).click();
  await page.getByRole('button', { name: '生成并导出', exact: true }).click();
  const image = await imageDownload;
  expect(image.suggestedFilename()).toContain('施工工期.png');
  const buf = await readFile((await image.path())!);
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  expect(buf.readUInt32BE(16)).toBe(9768);
  expect(buf.readUInt32BE(20)).toBeGreaterThan(2300);
  await image.saveAs('test-results/full-schedule.png');
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await closeToast(page);
  await page.screenshot({ path: 'test-results/desktop-workspace.png', fullPage: true });
});

test('storage failure is visible, retry saves and invalid stored data is never overwritten', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    (window as unknown as { savedTransaction: typeof original }).savedTransaction = original;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      if (args[1] === 'readwrite')
        throw new DOMException('Simulated disk quota', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await page.getByRole('button', { name: '编辑当前项目' }).click();
  await page.getByRole('dialog').getByLabel('项目名称', { exact: true }).fill('未保存的修改');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('保存失败');
  await expect(page.getByRole('alert')).toContainText('保存失败');
  expect((await state(page)).projects[0].name).toBe('栖桐里 · 理想之家');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '紧急备份' }).click();
  const dl = await pending;
  expect(JSON.parse(await readFile((await dl.path())!, 'utf8')).projects[0].name).toBe(
    '未保存的修改',
  );
  // Restore normal transaction behavior without reloading (which would discard unsaved memory).
  await page.evaluate(() => {
    IDBDatabase.prototype.transaction = (
      window as unknown as { savedTransaction: typeof IDBDatabase.prototype.transaction }
    ).savedTransaction;
  });
  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).projects[0].name).toBe('未保存的修改');
  await page.reload();
  await expect(page.locator('.current-project-name')).toHaveText('未保存的修改');
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const r = indexedDB.open('chunmo-workspace', 1);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put({ version: 999 }, 'data');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('读取失败');
  await expect(page.getByRole('alert')).toContainText('未覆盖原有数据');
  const stored = await state(page);
  expect(stored.version).toBe(999);
});

test('mobile touch workflow uses modals and fits viewport', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await closeToast(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '施工任务', exact: true }).tap();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('任务名称', { exact: true }).fill('触屏任务');
  await modal.getByLabel('开始日期', { exact: true }).fill('2026-11-01');
  await modal.getByLabel('结束日期', { exact: true }).fill('2026-11-03');
  await modal.getByRole('button', { name: '保存', exact: true }).tap();
  await expect
    .poll(async () => (await state(page)).tasks.some((t) => t.name === '触屏任务'))
    .toBe(true);
  await page.screenshot({ path: 'test-results/mobile-workspace.png', fullPage: true });
  await context.close();
});

test('task copy/delete, procurement CRUD, project settings validation and scroll alignment', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await closeToast(page);
  const bar = page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' });
  await editTask(page, bar);
  await page.getByRole('dialog').getByRole('button', { name: '复制', exact: true }).click();
  let modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: '新建施工任务' })).toBeVisible();
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线（副本）' }));
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(3);
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page.getByRole('button', { name: '新增采购', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('采购内容 / 事项标题', { exact: true }).fill('实木地板');
  await modal.getByLabel('采购截止日期', { exact: true }).fill('2026-10-20');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).purchases.length).toBe(2);
  await expect(page.locator('.stat-card').filter({ hasText: '已逾期采购' })).toContainText('1');
  await page
    .locator('.purchase-row')
    .filter({ hasText: '实木地板' })
    .getByRole('button', { name: '完成采购实木地板', exact: true })
    .click();
  await expect(page.locator('.stat-card').filter({ hasText: '已逾期采购' })).toContainText('暂无');
  await page.getByRole('button', { name: '编辑当前项目' }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('计划完工日期', { exact: true }).fill('2026-10-01');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('完工日期不能早于开工日期');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByLabel('定位日期', { exact: true }).fill('2026-12-31');
  const head = await page
    .getByRole('button', { name: '查看 2026-12-31 事项', exact: true })
    .boundingBox();
  const cell = await page
    .locator('.trade-row')
    .first()
    .locator('[data-date="2026-12-31"]')
    .boundingBox();
  expect(Math.abs(head!.x - cell!.x)).toBeLessThan(1);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await expect
    .poll(async () => page.getByTestId('gantt-scroll').evaluate((e) => e.scrollLeft))
    .toBe(0);
});
