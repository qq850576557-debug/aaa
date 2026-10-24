import { editTask } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { boot, closeToast, fixture, restore, state } from './helpers';

async function timeline(page: Page) {
  await closeToast(page);
  await page.locator('.schedule-section').scrollIntoViewIfNeeded();
}
async function move(page: Page, target: ReturnType<Page['locator']>, days: number) {
  await target.scrollIntoViewIfNeeded();
  const r = (await target.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + days * 56, r.y + r.height / 2, { steps: 12 });
  await page.mouse.up();
}
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
});

test('current workflow: blank double click creates procurement; explicit one-day task remains movable/resizable with undo', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await timeline(page);
  const row = page.locator('.trade-row').nth(2);
  await row.locator('[data-date="2026-10-24"]').dblclick();
  let form = page.getByRole('dialog', { name: '新建采购事项', exact: true });
  await expect(form.getByLabel('采购截止日期', { exact: true })).toHaveValue('2026-10-24');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '施工任务', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('任务名称', { exact: true }).fill('防水与闭水试验');
  await form.getByLabel('所属工种', { exact: true }).selectOption((await state(page)).trades[2].id);
  await form.getByLabel('开始日期', { exact: true }).fill('2026-10-24');
  await form.getByLabel('结束日期', { exact: true }).fill('2026-10-24');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  const task = (await state(page)).tasks.find((t) => t.name === '防水与闭水试验')!;
  expect(task.start).toBe('2026-10-24');
  expect(task.end).toBe('2026-10-24');
  const bar = row.getByTestId('task-bar');
  await move(page, bar, 2);
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === task.id)?.start)
    .toBe('2026-10-26');
  await move(page, bar.getByTestId('resize-end'), 2);
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === task.id)?.end)
    .toBe('2026-10-28');
  await move(page, bar.getByTestId('resize-start'), 1);
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === task.id)?.start)
    .toBe('2026-10-27');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === task.id)?.start)
    .toBe('2026-10-26');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).tasks.find((t) => t.id === task.id)?.end).toBe('2026-10-28');
});

test('phase 3: workspace stays unified, project cards drag with insertion line and persist without changing records', async ({
  page,
}) => {
  const d = fixture();
  const original = d.projects[0];
  const second = { ...original, id: 'project-b', name: '湖畔住宅', manager: '周经理' };
  const history = {
    ...original,
    id: 'project-history',
    name: '已完工住宅',
    status: '已完工' as const,
  };
  d.projects.push(second, history);
  await boot(page);
  await restore(page, d);
  const initial = await state(page);
  await closeToast(page);
  await expect(page.getByRole('button', { name: '施工计划', exact: true })).toHaveCount(0);
  const cards = page.locator('.project-card');
  await expect(cards).toHaveCount(2);
  await cards.nth(1).click();
  await expect(page.locator('.project-info h2')).toHaveText(second.name);
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.schedule-section')).toBeVisible();
  await expect(page.getByTestId('task-bar')).toHaveCount(0);
  await cards.first().click();
  await expect(page.getByTestId('task-bar')).toHaveCount(3);
  const source = (await cards.nth(1).boundingBox())!,
    target = (await cards.first().boundingBox())!;
  await page.mouse.move(source.x + 50, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(source.x + 58, source.y + 22, { steps: 4 });
  await page.mouse.move(target.x + 15, target.y + 20, { steps: 16 });
  await expect(page.locator('.project-card.sorting')).toHaveCSS('opacity', '0.6');
  // Native DnD needs a dragover at the final target, not merely its initial dragenter.
  await page.mouse.move(target.x + 15, target.y + 20);
  await expect(page.locator('.project-card.drop-before')).toHaveAttribute(
    'data-project-id',
    original.id,
  );
  // Verify cancellation independently before using Playwright's native dragTo action.
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.project-card.sorting')).toHaveCount(0);
  expect((await state(page)).projects).toEqual(initial.projects);
  await page
    .locator(`[data-project-id="${second.id}"]`)
    .dragTo(page.locator(`[data-project-id="${original.id}"]`), {
      sourcePosition: { x: 50, y: 20 },
      targetPosition: { x: 15, y: 20 },
    });
  await expect.poll(async () => (await state(page)).projects[0].id).toBe(second.id);
  expect((await state(page)).tasks).toEqual(d.tasks);
  expect((await state(page)).notes).toEqual(d.notes);
  expect((await state(page)).projects.find((p) => p.id === history.id)).toEqual(
    initial.projects.find((p) => p.id === history.id),
  );
  await page.reload();
  await expect(cards.first()).toContainText(second.name);
  await page.getByRole('button', { name: `切换项目${original.name}`, exact: true }).click();
  await timeline(page);
  await expect(page.locator('.active-project')).toContainText(original.name);
});

test('personnel: old project registration and name candidates survive central profile setup and JSON restore', async ({
  page,
}) => {
  const d = fixture();
  d.projects[0].personnel = { worker: '李师傅', manager: '王经理', designer: '陈设计' };
  d.nameHistory = ['李师傅', '王经理', '陈设计'];
  await boot(page);
  await restore(page, d);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.locator('.legacy-people summary').click();
  await expect(page.locator('.legacy-people')).toContainText('李师傅');
  await page.getByRole('button', { name: '用「李师傅」建档', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByLabel('姓名', { exact: true })).toHaveValue('李师傅');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).people?.length).toBe(1);
  expect((await state(page)).projects[0].personnel).toEqual(d.projects[0].personnel);
  await page.getByRole('button', { name: '数据与备份', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整 JSON 备份', exact: false }).click();
  const file = await download,
    backup = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(backup.projects[0].personnel).toEqual(d.projects[0].personnel);
  expect(backup.people[0].name).toBe('李师傅');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await restore(page, backup);
  expect((await state(page)).people).toEqual(backup.people);
  expect((await state(page)).nameHistory).toEqual(backup.nameHistory);
});

test('personnel: project/trade edits preserve untouched legacy names and task selection reuses registered identities', async ({
  page,
}) => {
  const d = fixture();
  d.nameHistory = ['陈设计'];
  d.projects[0].personnel = {
    worker: '李师傅',
    manager: d.projects[0].manager,
    designer: '陈设计',
  };
  d.trades[1].personnel = { worker: '赵师傅', manager: '', designer: '' };
  d.people = [
    { id: 'designer', name: '陈设计', role: '设计人员', trade: '', notes: '', active: true },
  ];
  await boot(page);
  await restore(page, d);
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  let panel = page.getByRole('dialog');
  await expect(panel.locator('.personnel-fields')).toHaveCount(0);
  await panel.getByLabel('项目备注', { exact: true }).fill('只修改备注');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects[0].notes).toBe('只修改备注');
  expect((await state(page)).nameHistory).not.toContain('李师傅');
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
  panel = page.getByRole('dialog');
  await expect(panel.locator('.personnel-fields')).toHaveCount(0);
  await panel.getByLabel('工种名称', { exact: true }).fill('水电');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).trades[1].name).toBe('水电');
  expect((await state(page)).trades[1].personnel).toEqual(d.trades[1].personnel);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' }));
  panel = page.getByRole('dialog');
  await panel.getByLabel('选择设计人员', { exact: true }).selectOption('designer');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks[1].staffIds).toEqual(['designer']);
  expect((await state(page)).tasks[1].tradeId).toBe(d.trades[1].id);
});

test('phase 3: compact rows/picker and actual supplied brand font fit desktop, mobile and enlarged views', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await timeline(page);
  await expect(page.locator('.trade-row').first()).toHaveCSS('height', '34px');
  await expect(page.getByTestId('task-bar').first()).toHaveCSS('font-size', '14px');
  const font = await page.evaluate(async () => {
    await document.fonts.load('28px ChunmoBrand', '春茉空间设计');
    return document.fonts.check('28px ChunmoBrand', '春茉空间设计');
  });
  expect(font).toBe(true);
  await expect(page.locator('.brand strong')).toHaveCSS('font-family', /ChunmoBrand/);
  const response = await page.request.get('/fonts/chunmo-brand.ttf');
  expect(response.ok()).toBe(true);
  expect((await response.body()).length).toBeGreaterThan(5000);
  for (const [width, height] of [
    [1440, 1000],
    [1280, 720],
    [1920, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.getByRole('button', { name: '设置水电改造颜色', exact: true }).click();
    const panel = page.getByRole('dialog');
    const r = (await panel.boundingBox())!;
    expect(r.width).toBeLessThanOrEqual(310);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(width);
    expect(r.y + r.height).toBeLessThanOrEqual(height);
    expect(await panel.evaluate((e) => e.matches(':modal'))).toBe(false);
    await expect(panel.locator('.w-color-wheel')).toHaveCSS('width', '100px');
    await panel.getByLabel('自定义颜色', { exact: true }).fill('#244e42');
    await expect(page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' })).toHaveCSS(
      'border-color',
      'rgb(36, 78, 66)',
    );
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    document.body.style.zoom = '1.25';
  });
  await timeline(page);
  await expect(page.getByTestId('task-bar').first()).toHaveCSS('font-size', '14px');
  await page.evaluate(() => {
    document.body.style.zoom = '1';
    window.scrollTo(0, 0);
  });
  await closeToast(page);
  await mkdir('/workspace/chunmo-stage3', { recursive: true });
  await page.screenshot({ path: '/workspace/chunmo-stage3/workspace.png', fullPage: true });
  await timeline(page);
  await page.getByRole('button', { name: '设置水电改造颜色', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: '/workspace/chunmo-stage3/compact-color.png',
    animations: 'disabled',
  });
});

test('phase 3: a newly created overlapping predecessor proposes downstream dates without committing before decision', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await timeline(page);
  await page.getByRole('button', { name: '施工任务', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('任务名称', { exact: true }).fill('补充拆改');
  await form.getByLabel('开始日期', { exact: true }).fill('2026-10-24');
  await form.getByLabel('结束日期', { exact: true }).fill('2026-10-26');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  let panel = page.getByRole('dialog', { name: '是否顺延后续工期？' });
  await expect(panel).toHaveAttribute('aria-modal', 'false');
  await expect(panel).toContainText('2026-10-27');
  expect((await state(page)).tasks).toHaveLength(3);
  await panel.getByRole('button', { name: '取消本次操作', exact: true }).click();
  expect((await state(page)).tasks).toHaveLength(3);
});

test('current feedback: failed PNG message expires after three seconds while inline error and data remain', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await closeToast(page);
  const before = await state(page);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.getByRole('button', { name: '导出施工工期长图', exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: '生成并导出', exact: true }).click();
  const notice = page.locator('.toast.error-toast');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCount(0, { timeout: 5000 });
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(await state(page)).toEqual(before);
  await panel.getByRole('button', { name: '关闭浮窗', exact: true }).click();
  await expect(notice).toHaveCount(0);
});
