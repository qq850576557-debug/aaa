import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { boot, restore, fixture, state, closeToast } from './helpers';
import { id, type Purchase } from '../src/lib/model';
test.use({ timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }, info) => {
  if (!info.title.includes('midnight'))
    await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
});
const todayPanel = (page: Page) => page.getByTestId('today-panel');
const upcoming = (page: Page) => page.getByTestId('upcoming-panel');
const metric = (page: Page, label: string) =>
  page.locator('.stat-card').filter({ hasText: label }).locator('strong');
async function addPurchase(page: Page, name: string, date: string) {
  await todayPanel(page).getByRole('button', { name: '添加采购事项', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '新建采购事项', exact: true });
  await panel.getByLabel('采购内容 / 事项标题', { exact: true }).fill(name);
  await panel.getByLabel('采购截止日期', { exact: true }).fill(date);
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).purchases.some((p) => p.name === name))
    .toBe(true);
}
function record(
  name: string,
  due: string,
  projectId = 'p-home',
  status: Purchase['status'] = '待采购',
): Purchase {
  return { id: id(), projectId, name, due, taskId: '', leadDays: 0, status, owner: '', notes: '' };
}
async function drag(page: Page, name: string, delta: number) {
  await closeToast(page);
  const bar = page.getByTestId('task-bar').filter({ hasText: name }).first();
  await bar.scrollIntoViewIfNeeded();
  const r = (await bar.boundingBox())!;
  await page.mouse.move(r.x + 24, r.y + 18);
  await page.mouse.down();
  await page.mouse.move(r.x + 24 + 56 * delta, r.y + 18, { steps: 12 });
  await page.mouse.up();
}

test('stage 4: one compact daily purchase updates all panels, indicators and counts; advance and complete persist', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  const initial = await state(page);
  await todayPanel(page).getByRole('button', { name: '添加采购事项', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新建采购事项', exact: true });
  await expect(form.getByLabel('所属项目', { exact: true })).toHaveCount(0);
  await expect(form).toContainText('所属项目：栖桐里');
  await expect(form.getByLabel('采购内容 / 事项标题', { exact: true })).toBeVisible();
  for (const label of [
    '持续天数',
    '前序任务（可选）',
    '提醒日期',
    '关联施工任务（可选）',
    '施工人员姓名',
    '负责人',
    '采购状态',
  ])
    await expect(form.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(form.locator('.personnel-fields')).toHaveCount(0);
  await form.getByLabel('采购内容 / 事项标题', { exact: true }).fill('厨房五金');
  await form.getByLabel('采购截止日期', { exact: true }).fill('2026-10-26');
  await form.getByLabel('详细备注（可选）', { exact: true }).fill('按图纸核对规格');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(upcoming(page)).toContainText('厨房五金');
  await expect(upcoming(page)).toContainText('剩余 3 天');
  await expect(todayPanel(page)).not.toContainText('厨房五金');
  await expect(metric(page, '未来 15 天采购')).toHaveText('2');
  let data = await state(page);
  const purchase = data.purchases.find((p) => p.name === '厨房五金')!;
  expect(data.notes).toEqual(initial.notes);
  expect(data.tasks).toEqual(initial.tasks);
  expect(purchase.originalDue).toBe('2026-10-26');
  const day = page.getByRole('button', { name: '查看 2026-10-26 事项', exact: true });
  await expect(day.locator('i')).toHaveAttribute('title', '1 条待办（采购 1 条）');
  await day.click();
  await expect(page.getByRole('dialog')).toContainText('厨房五金');
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  await upcoming(page).getByRole('button', { name: '编辑采购厨房五金', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('采购截止日期', { exact: true }).fill('2026-10-23');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(todayPanel(page)).toContainText('厨房五金');
  const todayCard = todayPanel(page).locator(`[data-purchase-id="${purchase.id}"]`),
    futureCard = upcoming(page).locator(`[data-purchase-id="${purchase.id}"]`);
  await expect(todayCard).toContainText('今天截止');
  await expect(futureCard).toContainText('今天截止');
  await expect(metric(page, '今日待办')).toHaveText('3');
  await expect(day.locator('i')).toHaveCount(0);
  await todayCard.getByRole('button', { name: '完成采购厨房五金', exact: true }).click();
  await expect(todayCard).toHaveCount(0);
  await expect(futureCard).toHaveCount(0);
  await expect(metric(page, '今日待办')).toHaveText('2');
  await expect(metric(page, '未来 15 天采购')).toHaveText('1');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  data = await state(page);
  expect(data.purchases.filter((p) => p.id === purchase.id)).toHaveLength(1);
  expect(data.purchases.find((p) => p.id === purchase.id)).toMatchObject({
    originalDue: '2026-10-26',
    due: '2026-10-23',
    status: '已完成',
  });
  expect(data.tasks).toEqual(initial.tasks);
});

test('stage 4: ordinary edits cannot move deadline past original; explicit local confirmation keeps original and backup history', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await addPurchase(page, '定制柜五金', '2026-10-26');
  await upcoming(page).getByRole('button', { name: '编辑采购定制柜五金', exact: true }).click();
  let form = page.getByRole('dialog');
  await form.getByRole('button', { name: '选择采购截止日期', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '采购截止日期日历', exact: true })
      .getByRole('button', { name: '选择 2026-10-27', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await form.getByLabel('采购截止日期', { exact: true }).fill('2026-10-27');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  expect(
    await form
      .getByLabel('采购截止日期', { exact: true })
      .evaluate((e) => (e as HTMLInputElement).checkValidity()),
  ).toBe(false);
  expect((await state(page)).purchases.find((p) => p.name === '定制柜五金')?.due).toBe(
    '2026-10-26',
  );
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await upcoming(page).getByRole('button', { name: '编辑采购定制柜五金', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByRole('button', { name: '变更原定期限', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认变更原定采购期限', exact: true });
  await expect(confirm).toHaveAttribute('aria-modal', 'true');
  await expect(confirm).toContainText('不是负责人账号授权');
  await confirm.getByLabel('新的最晚采购期限', { exact: true }).fill('2026-10-30');
  await confirm.getByRole('button', { name: '确认变更期限', exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByLabel('变更原因', { exact: true }).fill('供应商协调，现场已明确确认');
  await confirm.getByRole('button', { name: '确认变更期限', exact: true }).click();
  await expect
    .poll(
      async () => (await state(page)).purchases.find((p) => p.name === '定制柜五金')?.approvedDue,
    )
    .toBe('2026-10-30');
  const data = await state(page),
    purchase = data.purchases.find((p) => p.name === '定制柜五金')!;
  expect(purchase.originalDue).toBe('2026-10-26');
  expect(purchase.deadlineHistory).toHaveLength(1);
  expect(purchase.deadlineHistory![0]).toMatchObject({
    from: '2026-10-26',
    to: '2026-10-30',
    reason: '供应商协调，现场已明确确认',
  });
  await page.getByRole('button', { name: '数据与备份', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整 JSON 备份', exact: false }).click();
  const file = await downloading;
  const backup = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(backup.purchases).toEqual(data.purchases);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await restore(page, backup);
  expect((await state(page)).purchases).toEqual(backup.purchases);
  await upcoming(page).getByRole('button', { name: '编辑采购定制柜五金', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('采购截止日期', { exact: true }).fill('2026-10-31');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  expect(
    await form
      .getByLabel('采购截止日期', { exact: true })
      .evaluate((e) => (e as HTMLInputElement).checkValidity()),
  ).toBe(false);
});

test('stage 4: overdue days, completed compatibility, inclusive future boundary and projects remain isolated', async ({
  page,
}) => {
  const d = fixture();
  d.projects.push({ ...d.projects[0], id: 'project-two', name: '第二个工地' });
  d.purchases = [
    record('逾期瓷砖', '2026-10-21'),
    record('十五天材料', '2026-11-07'),
    record('十六天材料', '2026-11-08'),
    record('已完成材料', '2026-10-23', 'p-home', '已完成'),
    record('旧已到货', '2026-10-23', 'p-home', '已到货'),
    record('乙工地材料', '2026-10-23', 'project-two'),
  ];
  await boot(page);
  await restore(page, d);
  await expect(todayPanel(page)).toContainText('逾期瓷砖');
  await expect(todayPanel(page)).toContainText('已逾期 2 天');
  await expect(todayPanel(page)).not.toContainText('已完成材料');
  await expect(todayPanel(page)).not.toContainText('旧已到货');
  await expect(todayPanel(page)).not.toContainText('乙工地材料');
  await expect(upcoming(page)).toContainText('十五天材料');
  await expect(upcoming(page)).toContainText('剩余 15 天');
  await expect(upcoming(page)).not.toContainText('十六天材料');
  await expect(metric(page, '今日待办')).toHaveText('3');
  await expect(metric(page, '未来 15 天采购')).toHaveText('2');
  await expect(metric(page, '已逾期采购')).toHaveText('1');
  await page.locator('[data-project-id="project-two"]').click();
  await expect(todayPanel(page)).toContainText('乙工地材料');
  await expect(todayPanel(page)).not.toContainText('逾期瓷砖');
  await expect(upcoming(page)).not.toContainText('十五天材料');
  await todayPanel(page).getByRole('button', { name: '完成采购乙工地材料', exact: true }).click();
  await expect(metric(page, '今日待办')).toHaveText('2');
  await expect(metric(page, '未来 15 天采购')).toHaveText('1');
  await page.locator('[data-project-id="p-home"]').click();
  await expect(todayPanel(page)).toContainText('已逾期 2 天');
  expect((await state(page)).purchases.find((p) => p.name === '逾期瓷砖')?.status).toBe('待采购');
  await mkdir('/workspace/chunmo-stage4', { recursive: true });
  await closeToast(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '/workspace/chunmo-stage4/procurement-workspace.png',
    fullPage: true,
  });
});

test('stage 4: midnight automatically updates relative time and today projection without edits', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-23T23:59:50+08:00') });
  const d = fixture();
  d.notes = [];
  d.purchases = [record('跨日材料', '2026-10-24')];
  await boot(page);
  await restore(page, d);
  await expect(upcoming(page)).toContainText('剩余 1 天');
  await expect(todayPanel(page)).not.toContainText('跨日材料');
  await expect(metric(page, '今日待办')).toHaveText('暂无');
  await page.clock.runFor(31000);
  await expect(todayPanel(page)).toContainText('跨日材料');
  await expect(upcoming(page)).toContainText('今天截止');
  await expect(metric(page, '今日待办')).toHaveText('1');
});

test('stage 4: bar double click never edits; context menu deletion confirms and preserves related procurement and notes', async ({
  page,
}) => {
  const d = fixture();
  d.notes[0].taskId = 't-water';
  d.tasks[0].dependsOn = ['t-water'];
  await boot(page);
  await restore(page, d);
  await closeToast(page);
  const initial = await state(page);
  const bar = page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' });
  await bar.dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await state(page)).tasks).toEqual(initial.tasks);
  await bar.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '水电定位与布线时间条操作', exact: true });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await mkdir('/workspace/chunmo-stage4', { recursive: true });
  await page.screenshot({
    path: '/workspace/chunmo-stage4/timebar-menu.png',
    animations: 'disabled',
  });
  await menu.getByRole('menuitem', { name: '删除时间条', exact: true }).click();
  let confirm = page.getByRole('dialog', { name: '删除「水电定位与布线」？', exact: true });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  expect((await state(page)).tasks).toHaveLength(3);
  await bar.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除时间条', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(2);
  const data = await state(page);
  expect(data.purchases[0]).toMatchObject({
    taskId: '',
    due: '2026-10-23',
    originalDue: '2026-10-23',
  });
  expect(data.notes[0].taskId).toBeUndefined();
  expect(data.notes[0].content).toBe(initial.notes[0].content);
  expect(data.tasks[0].dependsOn).toEqual([]);
  await expect(todayPanel(page)).toContainText('电线及线管');
  await expect(upcoming(page)).toContainText('电线及线管');
  await page.reload();
  expect((await state(page)).tasks).toHaveLength(2);
  await expect(page.getByTestId('task-bar')).toHaveCount(1);
  await page.locator('.task-details-list summary').click();
  await page.getByRole('button', { name: '编辑任务现场保护与拆改', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑施工任务', exact: true })).toBeVisible();
});

test('stage 4: linked procurement follows an earlier drag but later construction never silently postpones original deadline', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  const initial = await state(page);
  await drag(page, '水电定位与布线', 2);
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-28');
  await expect(todayPanel(page)).toContainText('今天截止');
  expect((await state(page)).purchases[0].originalDue).toBe('2026-10-23');
  await drag(page, '水电定位与布线', -4);
  await page
    .getByRole('dialog', { name: '当前工序已提前，是否同步提前后续工序？', exact: true })
    .getByRole('button', { name: '不调整', exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-24');
  const card = todayPanel(page).locator(`[data-purchase-id="${initial.purchases[0].id}"]`);
  await expect(card).toContainText('2026-10-21 前采购');
  await expect(card).toContainText('已逾期 2 天');
  await expect(upcoming(page)).not.toContainText('电线及线管');
  await expect(metric(page, '已逾期采购')).toHaveText('1');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-28');
  await expect(todayPanel(page)).toContainText('2026-10-23 前采购');
});

test('stage 4: personnel navigation is separate, old preparation statuses display as construction and survive editing', async ({
  page,
}) => {
  const d = fixture();
  d.projects[0].status = '筹备中';
  d.projects[0].personnel = { worker: '李师傅', manager: '沈设计', designer: '陈设计' };
  d.projects.push({ ...d.projects[0], id: 'p-two', name: '旧进行中工地', status: '进行中' });
  await boot(page);
  await restore(page, d);
  await expect(page.locator('.project-status').filter({ hasText: '施工中' })).toHaveCount(2);
  await expect(metric(page, '施工中的项目')).toHaveText('2');
  await page.locator('.stat-card').filter({ hasText: '施工中的项目' }).click();
  await expect(page.locator('.project-card')).toHaveCount(2);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.locator('.people-panel')).toContainText('李师傅');
  await expect(page.locator('.people-panel')).toContainText('未开放采集');
  await expect(page.locator('.people-panel input[type=tel]')).toHaveCount(0);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  let form = page.getByRole('dialog');
  await expect(form.getByLabel('项目状态', { exact: true })).toHaveValue('施工中');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects[0].status).toBe('施工中');
  expect((await state(page)).tasks).toEqual(d.tasks);
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  form = page.getByRole('dialog');
  await expect(form.getByLabel('项目状态', { exact: true })).toHaveValue('施工中');
  await form.getByLabel('项目名称', { exact: true }).fill('新施工工地');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects.length).toBe(3);
});

test('stage 4: mobile has separate people navigation and compact procurement; task details remain reachable independently', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await restore(page);
  await closeToast(page);
  await todayPanel(page).getByRole('button', { name: '添加采购事项', exact: true }).click();
  const form = page.getByRole('dialog');
  await expect(form.locator('.personnel-fields')).toHaveCount(0);
  await expect(form.getByLabel('采购截止日期', { exact: true })).toBeVisible();
  expect((await form.boundingBox())!.width).toBeLessThan(390);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.locator('.people-panel')).toBeVisible();
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page.locator('.task-details-list summary').click();
  await page.getByRole('button', { name: '编辑任务现场保护与拆改', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑施工任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭浮窗' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('stage 4: global reminders edit the purchase owner project after visiting an empty completed workspace', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await closeToast(page);
  await page.getByRole('button', { name: '已完工项目', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '暂无已完工项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提醒中心', exact: true }).click();
  await page.getByRole('button', { name: '编辑采购电线及线管', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('所属项目', { exact: true })).toHaveCount(0);
  await expect(panel).toContainText('所属项目：栖桐里');
  await panel.getByLabel('详细备注（可选）', { exact: true }).fill('从全局提醒更新采购备注');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).purchases[0].notes)
    .toBe('从全局提醒更新采购备注');
  expect((await state(page)).purchases[0].projectId).toBe('p-home');
});
