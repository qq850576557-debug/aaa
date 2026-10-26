import { editTask } from './helpers';
import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { boot, restore, fixture, state, closeToast } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
});

test('review: color and editors are nonblocking panels; confirmation remains modal and date stays in viewport', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await closeToast(page);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByRole('button', { name: '设置水电改造颜色', exact: true }).click();
  let panel = page.getByRole('dialog');
  await expect(panel).toHaveAttribute('aria-modal', 'false');
  expect(await panel.evaluate((e) => e.matches(':modal'))).toBe(false);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  const before = await page.evaluate(() => scrollY);
  await page.mouse.move(1420, 150);
  await page.mouse.wheel(0, before > 100 ? -200 : 200);
  await expect.poll(async () => page.evaluate(() => scrollY)).not.toBe(before);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('自定义颜色', { exact: true })).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '1');
  await mkdir('/workspace/chunmo-review/after', { recursive: true });
  await page.screenshot({ path: '/workspace/chunmo-review/after/color.png' });
  await page.mouse.click(8, 8);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' }));
  panel = page.getByRole('dialog');
  await expect(panel).toHaveAttribute('aria-modal', 'false');
  await panel.getByRole('button', { name: '选择开始日期', exact: true }).click();
  let calendar = page.getByRole('dialog', { name: '开始日期日历', exact: true });
  await expect(calendar).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 720 });
  const r = await calendar.boundingBox();
  expect(r!.x).toBeGreaterThanOrEqual(0);
  expect(r!.x + r!.width).toBeLessThanOrEqual(1000);
  expect(r!.y + r!.height).toBeLessThanOrEqual(720);
  await page.keyboard.press('Escape');
  await expect(calendar).not.toBeVisible();
  await expect(panel).toBeVisible();
  await panel.getByLabel('任务名称', { exact: true }).fill('待保存修改');
  await page.mouse.click(8, 8);
  const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？' });
  await expect(confirm).toHaveAttribute('aria-modal', 'true');
  expect(await confirm.evaluate((e) => e.matches(':modal'))).toBe(true);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel.getByLabel('任务名称', { exact: true })).toHaveValue('待保存修改');
});

test('review: merged predecessor prompts before moving related tasks and updates associations atomically', async ({
  page,
}) => {
  const d = fixture(),
    root = d.tasks[0];
  d.tasks.push({
    ...root,
    id: 'merge-later',
    groupId: root.id,
    start: '2026-10-28',
    end: '2026-10-29',
  });
  d.tasks[1].dependsOn = [root.id];
  d.notes[0].taskId = root.id;
  d.purchases[0].taskId = root.id;
  await boot(page);
  await restore(page, d);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  const segment = page.getByTestId('task-bar').filter({ hasText: root.name }).nth(1);
  await editTask(page, segment);
  let panel = page.getByRole('dialog');
  await panel.getByLabel('开始日期', { exact: true }).fill('2026-10-26');
  await panel.getByLabel('结束日期', { exact: true }).fill('2026-10-27');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '是否顺延后续工期？' })).toBeVisible();
  expect((await state(page)).tasks).toHaveLength(4);
  expect((await state(page)).tasks[1].start).toBe('2026-10-26');
  await page.getByRole('button', { name: '顺延后续工期', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-28');
  const saved = await state(page);
  expect(saved.tasks).toHaveLength(3);
  expect(saved.notes[0].taskId).toBe('merge-later');
  expect(saved.purchases[0].taskId).toBe('merge-later');
  expect(saved.tasks.find((t) => t.id === 't-water')?.dependsOn).toEqual(['merge-later']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  expect((await state(page)).notes[0].taskId).toBe(root.id);
});

test('review: an invalid downstream shift cannot block valid current-only edits', async ({
  page,
}) => {
  const d = fixture();
  d.projects[0].start = '2200-12-20';
  d.projects[0].end = '2200-12-31';
  d.tasks = d.tasks.slice(0, 2);
  d.tasks[0].start = '2200-12-28';
  d.tasks[0].end = '2200-12-29';
  d.tasks[1].start = '2200-12-30';
  d.tasks[1].end = '2200-12-31';
  d.tasks[1].dependsOn = [d.tasks[0].id];
  d.notes = [];
  d.purchases = [];
  await boot(page);
  await restore(page, d);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByLabel('定位日期', { exact: true }).fill('2200-12-28');
  await editTask(page, page.getByTestId('task-bar').first());
  let panel = page.getByRole('dialog');
  await panel.getByLabel('结束日期', { exact: true }).fill('2200-12-31');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  panel = page.getByRole('dialog', { name: '是否顺延后续工期？' });
  await expect(panel.getByRole('alert')).toContainText('顺延方案超出可保存范围');
  await expect(panel.getByRole('button', { name: '顺延后续工期', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '仅调整当前工序', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks[0].end).toBe('2200-12-31');
  expect((await state(page)).tasks[1].start).toBe('2200-12-30');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).tasks[0].end).toBe('2200-12-31');
});

test('review: export locks options, invalidates stale files and draws all dates and offscreen tasks', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await closeToast(page);
  await page.evaluate(() => {
    const win = window as unknown as { draws: { text: string; font: string }[] };
    win.draws = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fill>) {
      win.draws.push({ text: args[0], font: this.font });
      return fill.apply(this, args);
    };
    const blob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args: Parameters<typeof blob>) {
      const canvas = this;
      setTimeout(() => blob.apply(canvas, args), 350);
    };
  });
  await page.getByRole('button', { name: '导出施工工期长图', exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('combobox', { name: '导出方式', exact: true }).selectOption('month');
  await panel.getByRole('button', { name: '生成并导出', exact: true }).click();
  await expect(panel.getByLabel('导出开始日期', { exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '选择导出结束日期', exact: true })).toBeDisabled();
  await expect(panel.locator('.export-files button')).toHaveCount(3);
  await panel.getByLabel('导出开始日期', { exact: true }).fill('2026-10-25');
  await expect(panel.locator('.export-files button')).toHaveCount(0);
  await panel.getByLabel('导出开始日期', { exact: true }).fill('2026-10-22');
  await panel.getByRole('combobox', { name: '导出方式', exact: true }).selectOption('full');
  await page.evaluate(() => {
    (window as unknown as { draws: unknown[] }).draws = [];
  });
  const downloaded = page.waitForEvent('download');
  await panel.getByRole('button', { name: '生成并导出', exact: true }).click();
  const file = await downloaded,
    buffer = await readFile((await file.path())!);
  expect(buffer.readUInt32BE(16)).toBe(9768);
  expect(buffer.readUInt32BE(20)).toBe(2640);
  const draws = await page.evaluate(
    () => (window as unknown as { draws: { text: string; font: string }[] }).draws,
  );
  expect(draws.filter((x) => /^\d{2}\/\d{2}$/.test(x.text))).toHaveLength(71);
  expect(draws.some((x) => x.text === '12/31')).toBe(true);
  expect(draws.some((x) => x.text.includes('竣工联合验收'))).toBe(true);
  expect(draws.some((x) => x.text === '周四' && x.font.includes('14px'))).toBe(true);
  await mkdir('/workspace/chunmo-review/after', { recursive: true });
  await file.saveAs('/workspace/chunmo-review/after/full-schedule.png');
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await closeToast(page);
  await page.screenshot({ path: '/workspace/chunmo-review/after/desktop.png', fullPage: true });
});
