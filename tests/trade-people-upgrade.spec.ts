import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { defaultTrades } from '../src/lib/model';
const screenshots = '/tmp/chunmo-trades-people';
test.beforeAll(() => mkdir(screenshots, { recursive: true }));
import { boot, restore, state, closeToast, peopleTradeFixture } from './helpers';

for (const width of [1440, 1280, 390, 320]) {
  test(`trade and people UI ${width}: independent colors, compact single target and retained hidden staff roles`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await boot(page);
    const before = peopleTradeFixture();
    await restore(page, before);
    await closeToast(page);
    await expect(page.locator('.workspace-anchors')).toHaveCount(0);
    for (const title of ['今日事项', '明日提醒', '项目备忘'])
      await expect(
        page.getByRole('heading', { name: new RegExp('^' + title) }).first(),
      ).toBeVisible();
    const row = page.locator(`[data-trade-id="${before.trades[1].id}"]`);
    await expect(row.locator('.trade-color')).toHaveCount(0);
    await row.locator('.trade-workers').click();
    const editor = page.getByRole('dialog', { name: '编辑工种', exact: true });
    for (const role of ['项目经理', '设计人员', '监理'])
      await expect(editor.getByLabel('选择' + role, { exact: true })).toHaveCount(0);
    await editor.getByLabel('分配施工人员师傅2', { exact: true }).check();
    await page.screenshot({
      path: `${screenshots}/trade-editor-${width}.png`,
      animations: 'disabled',
    });
    await editor.locator('.trade-colors > summary').click();
    await editor.getByLabel('自定义颜色', { exact: true }).fill('#d65d42');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await state(page)).trades[1].color).toBe('#d65d42');
    const saved = await state(page);
    expect(saved.tasks).toEqual(before.tasks);
    expect(saved.trades[1].personnel).toEqual(before.trades[1].personnel);
    expect(saved.trades[1].staffIds).toEqual([
      'person-0',
      'role-0',
      'role-1',
      'role-2',
      'person-1',
    ]);
    await expect(row.locator('.task-bar').first()).toHaveCSS('border-color', 'rgb(214, 93, 66)');
    expect(
      await row.locator('.trade-info-card').evaluate((e) => getComputedStyle(e).backgroundColor),
    ).not.toBe('rgb(255, 255, 255)');
    const color = await row.locator('.trade-info-card').getAttribute('style');
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(row.locator('.task-bar').first()).toHaveCSS('border-color', 'rgb(214, 93, 66)');
    expect(await row.locator('.trade-info-card').getAttribute('style')).toBe(color);
    await page.locator('#project-timeline').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/timeline-${width}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    const heading = await page
        .getByRole('heading', { name: '人员档案', exact: true })
        .boundingBox(),
      search = await page.getByLabel('搜索人员', { exact: true }).boundingBox();
    if (width >= 1280) {
      expect(search!.x).toBeGreaterThan(heading!.x + heading!.width);
      expect(
        Math.abs(search!.y + search!.height / 2 - heading!.y - heading!.height / 2),
      ).toBeLessThan(2);
    }
    await expect(
      page.getByText('统一维护人员，并分配至项目、工种或施工任务。', { exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('搜索人员', { exact: true }).fill('师傅2');
    await expect(page.locator('.people-grid > [data-person-id]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test(`worker catalog ${width}: search, aliases, custom CRUD/order and retained stage/person references`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await boot(page);
    const before = peopleTradeFixture();
    await restore(page, before);
    await closeToast(page);
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    await page.getByRole('button', { name: '打开人员档案：师傅1', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑人员档案', exact: true });
    const searchIcon = await editor.locator('.worker-picker-search > svg').boundingBox(),
      searchInput = await editor.getByLabel('搜索人员工种', { exact: true }).boundingBox();
    expect(searchInput!.x).toBeGreaterThan(searchIcon!.x + searchIcon!.width);
    expect(
      Math.abs(searchIcon!.y + searchIcon!.height / 2 - searchInput!.y - searchInput!.height / 2),
    ).toBeLessThan(2);
    await expect(editor.getByLabel('人员工种木工', { exact: true })).toHaveCount(1);
    for (const stage of ['木工吊顶', '水电改造', '墙地砖铺贴', '油漆阶段'])
      await expect(editor.getByLabel('人员工种' + stage, { exact: true })).toHaveCount(0);
    await expect(editor.locator('.worker-legacy-tag')).toContainText('木工吊顶');
    await page.screenshot({
      path: `${screenshots}/worker-picker-${width}.png`,
      animations: 'disabled',
    });
    await editor.getByLabel('搜索人员工种', { exact: true }).fill('水电');
    await expect(editor.locator('.worker-trade-options input')).toHaveCount(1);
    await editor.getByLabel('人员工种水电工', { exact: true }).check();
    await expect(editor.getByLabel('已选人员工种')).toContainText('水电工');
    await editor.getByLabel('移除工种水电工', { exact: true }).click();
    await editor.getByRole('button', { name: '工种管理', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '人员工种管理', exact: true });
    await manager.getByRole('button', { name: '新增工种', exact: true }).click();
    const add = page.getByRole('dialog', { name: '新增人员工种', exact: true });
    await add.getByLabel('人员工种名称').fill('木工吊顶');
    await add.getByRole('button', { name: '保存工种', exact: true }).click();
    await expect(add.getByRole('alert')).toContainText('施工阶段');
    await add.getByLabel('人员工种名称').fill('玻璃安装工');
    await add.getByRole('button', { name: '保存工种', exact: true }).click();
    await expect(add).toHaveCount(0);
    const wood = manager
      .locator('.dictionary-row')
      .filter({ has: page.getByText('木工', { exact: true }) });
    await wood.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑人员工种', exact: true });
    await edit.getByLabel('人员工种名称').fill('精细木作');
    await edit.getByRole('button', { name: '保存工种', exact: true }).click();
    await manager.getByRole('button', { name: '删除工种精细木作', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '此工种已被使用，改为停用？', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    await manager.getByRole('button', { name: '上移工种玻璃安装工', exact: true }).click();
    await manager.getByRole('button', { name: '删除工种玻璃安装工', exact: true }).click();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    await page.screenshot({
      path: `${screenshots}/worker-manager-${width}.png`,
      animations: 'disabled',
    });
    await manager.getByRole('button', { name: '关闭', exact: true }).click();
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(
        async () => (await state(page)).dictionaries?.find((x) => x.id === 'worker-wood')?.active,
      )
      .toBe(false);
    const saved = await state(page);
    expect(saved.people![0].tradeIds).toEqual(before.people![0].tradeIds);
    expect(saved.dictionaries!.find((x) => x.id === 'stage-wood')).toEqual(before.dictionaries![2]);
    expect(saved.dictionaries!.find((x) => x.id === 'worker-wood')!.label).toBe('精细木作');
    expect(saved.tasks).toEqual(before.tasks);
    expect(saved.trades).toEqual(before.trades);
    await page.reload();
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    await expect(page.locator('[data-person-id="person-0"]')).toContainText('精细木作');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('person cards: cross-row drag, same-row insertion, pointer cancellation, mobile controls and persistent unchanged profiles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await boot(page);
  const before = peopleTradeFixture();
  await restore(page, before);
  await closeToast(page);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  const grid = page.locator('.people-grid');
  await grid.evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 150));
  const rects = await grid.locator('> [data-person-id]').evaluateAll((es) =>
    es.map((e) => ({
      id: e.getAttribute('data-person-id')!,
      x: e.getBoundingClientRect().x,
      y: e.getBoundingClientRect().y,
      w: e.getBoundingClientRect().width,
      h: e.getBoundingClientRect().height,
    })),
  );
  const source = rects[0],
    target = rects.find((r) => r.y > source.y + 30)!;
  expect(target).toBeTruthy();
  const handle = grid.locator(`[data-person-id="${source.id}"] .person-sort-handle`),
    h = await handle.boundingBox();
  await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 12, target.y + 65, { steps: 12 });
  await expect(grid.locator(`[data-person-id="${target.id}"].person-drop-before`)).toBeVisible();
  await expect(page.locator('.person-sort-ghost')).toBeVisible();
  await page.screenshot({ path: `${screenshots}/people-drag-1440.png`, animations: 'disabled' });
  expect(
    await grid
      .locator(`[data-person-id="${source.id}"]`)
      .evaluate((e) => Number(getComputedStyle(e).opacity)),
  ).toBeLessThan(0.5);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.mouse.up();
  const expected = before.people!.map((p) => p.id).filter((id) => id !== source.id);
  expected.splice(expected.indexOf(target.id), 0, source.id);
  await expect.poll(async () => (await state(page)).people!.map((p) => p.id)).toEqual(expected);
  await expect
    .poll(() =>
      grid
        .locator('> [data-person-id]')
        .evaluateAll(
          (es) =>
            es.flatMap((e) => e.getAnimations()).filter((a) => a.playState === 'running').length,
        ),
    )
    .toBe(0);
  const first = grid.locator('> [data-person-id]').first(),
    second = grid.locator('> [data-person-id]').nth(1),
    h2 = await second.locator('.person-sort-handle').boundingBox(),
    r1 = await first.boundingBox();
  await page.mouse.move(h2!.x + 10, h2!.y + 10);
  await page.mouse.down();
  await page.mouse.move(r1!.x + 5, r1!.y + 65, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await state(page)).people!.map((p) => p.id)).toEqual(expected);
  await expect(page.locator('.person-sort-ghost')).toHaveCount(0);
  await page.mouse.move(h2!.x + 10, h2!.y + 10);
  await page.mouse.down();
  await page.mouse.move(r1!.x + 5, r1!.y + 65, { steps: 8 });
  await page.mouse.up();
  const expected2 = [expected[1], expected[0], ...expected.slice(2)];
  await expect.poll(async () => (await state(page)).people!.map((p) => p.id)).toEqual(expected2);
  await page.reload();
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(grid.locator('> [data-person-id]').first()).toHaveAttribute(
    'data-person-id',
    expected2[0],
  );
  await page.setViewportSize({ width: 320, height: 1000 });
  const current = (await state(page)).people!;
  await page.getByRole('button', { name: '下移人员' + current[0].name, exact: true }).click();
  await expect.poll(async () => (await state(page)).people![1].id).toBe(current[0].id);
  const saved = await state(page);
  for (const p of saved.people!) expect(p).toEqual(before.people!.find((x) => x.id === p.id));
  expect(saved.tasks).toEqual(before.tasks);
  expect(saved.trades).toEqual(before.trades);
});
test('shared stage color explicitly synchronizes projects; preview cancellation and non-color edits preserve existing custom values', async ({
  page,
}) => {
  await boot(page);
  const d = peopleTradeFixture();
  const other = { ...d.projects[0], id: 'another-site', name: '另一工地' };
  d.projects.push(other);
  const trades = defaultTrades(other.id);
  trades[1].color = '#814ac2';
  d.trades.push(...trades);
  await restore(page, d);
  await closeToast(page);
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '编辑工种', exact: true });
  await editor.getByLabel('分配施工人员师傅2', { exact: true }).check();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).trades[1].staffIds).toContain('person-1');
  expect((await state(page)).trades.find((g) => g.id === trades[1].id)!.color).toBe('#814ac2');
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click({ button: 'right' });
  const popover = page.getByRole('dialog', { name: '水电改造 · 工种颜色', exact: true });
  await popover.getByLabel('自定义颜色', { exact: true }).fill('#7a47c2');
  await expect.poll(async () => (await state(page)).trades[1].color).toBe('#7a47c2');
  expect((await state(page)).trades.find((g) => g.id === trades[1].id)!.color).toBe('#814ac2');
  await popover.getByRole('button', { name: '取消并恢复', exact: true }).click();
  await expect.poll(async () => (await state(page)).trades[1].color).toBe(d.trades[1].color);
  expect((await state(page)).trades.find((g) => g.id === trades[1].id)!.color).toBe('#814ac2');
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑工种', exact: true });
  await editor.locator('.trade-colors > summary').click();
  await editor.getByLabel('自定义颜色', { exact: true }).fill('#d65d42');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () =>
      (await state(page)).trades.filter((g) => g.name === '水电改造').map((g) => g.color),
    )
    .toEqual(['#d65d42', '#d65d42']);
  expect((await state(page)).tasks).toEqual(d.tasks);
});

test('real mobile touch sorts a single-column personnel list with a horizontal insertion line and retains exact profile fields', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 1000 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await boot(page);
    const d = peopleTradeFixture();
    await restore(page, d);
    await closeToast(page);
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    const grid = page.locator('.people-grid');
    await grid.evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 150));
    const source = await page
        .getByRole('button', { name: '拖动人员师傅1', exact: true })
        .boundingBox(),
      target = await grid.locator('[data-person-id="person-1"]').boundingBox();
    const cdp = await context.newCDPSession(page),
      x = source!.x + source!.width / 2,
      y = source!.y + source!.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    const endX = target!.x + target!.width / 2,
      endY = target!.y + target!.height * 0.65;
    for (let step = 1; step <= 10; step++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + ((endX - x) * step) / 10, y: y + ((endY - y) * step) / 10 }],
      });
    await expect(
      grid.locator('[data-person-id="person-1"].person-drop-vertical.person-drop-after'),
    ).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await state(page)).people![1].id).toBe('person-0');
    for (const p of (await state(page)).people!)
      expect(p).toEqual(d.people!.find((x) => x.id === p.id));
  } finally {
    await context.close();
  }
});
