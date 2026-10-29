import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { mkdir } from 'node:fs/promises';
// Each spec owns its inspection connection; another spec may have closed its API module pool.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
test.afterAll(async () => {
  await pool.end();
});
async function login(p: Page, name: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(name);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
async function api(c: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await c.request.get('/api/auth/session')).json();
  return c.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function seed(c: BrowserContext) {
  const d = fixture();
  d.projects.push(
    ...['云杉庭', '溪岸居', '星河里', '南山院', '望月台'].map((name, i) => ({
      ...d.projects[0],
      id: 'board-project-' + i,
      name,
    })),
  );
  const saved = await api(c, '/workspace', 'PUT', { revision: 0, data: d });
  expect(saved.status()).toBe(200);
  for (const p of d.projects) {
    const r = await api(c, '/records', 'POST', {
      requestId: randomUUID(),
      value: {
        projectId: p.id,
        title: `${p.name} · 确认现场收口与成品保护`,
        nodeDate: '2026-11-02',
        status: '持续跟进',
        notes: '复核规格与设计要求，避免现场返工。',
        followUp: '已与业主约定现场复核；完成后记录确认结果。',
      },
    });
    expect(r.status()).toBe(200);
  }
  return d;
}
for (const width of [1440, 1280, 390])
  test(`record board ${width}: create, inline drawer edit/history, filters/group/sort, scroll and protected deletion`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await pool.query('UPDATE account SET display_name=$1 WHERE id=$2', ['林设计', f.id]);
    await login(page, f.login, f.password);
    const d = await seed(context);
    await page.reload();
    await page.getByRole('button', { name: '记录状态看板', exact: true }).click();
    const board = page.getByRole('region', { name: '记录状态看板', exact: true });
    await expect(board.locator('.board-lane')).toHaveCount(6);
    await expect(board.locator('.record-card')).toHaveCount(6);
    const lane = board.getByRole('region', { name: d.projects[0].name, exact: true });
    await lane
      .getByRole('button', { name: `在${d.projects[0].name}新增记录`, exact: true })
      .click();
    const drawer = page.locator('.record-drawer');
    await expect(drawer.getByLabel('记录所属项目', { exact: true })).toHaveValue(d.projects[0].id);
    await drawer.getByLabel('任务事项', { exact: true }).fill('复核厨房台面与插座');
    await drawer.getByLabel('记录节点日期', { exact: true }).fill('2026-11-03');
    await drawer.getByLabel('记录备注', { exact: true }).fill('核对高度，保留全部字段');
    await drawer.getByLabel('记录跟进', { exact: true }).fill('等待业主确认');
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    const card = board.getByRole('button', { name: '打开记录：复核厨房台面与插座', exact: true });
    await expect(card).toBeVisible();
    await expect(lane.locator('.lane-count')).toHaveText('2');
    await card.click();
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () =>
        Math.round((await drawer.boundingBox())!.x + (await drawer.boundingBox())!.width),
      )
      .toBe(width);
    const box = (await drawer.boundingBox())!;
    expect(box.x + box.width).toBe(width);
    expect(box.y).toBe(0);
    expect(box.height).toBe(1000);
    expect(box.width).toBeLessThanOrEqual(width);
    await drawer.getByLabel('记录状态', { exact: true }).selectOption('已完成');
    await drawer.getByLabel('记录跟进', { exact: true }).fill('业主已确认，按图施工');
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(card).toContainText('已完成');
    await expect(card).toContainText('业主已确认');
    await card.click();
    await drawer.getByRole('tab', { name: '历史', exact: true }).click();
    await expect(drawer.locator('.record-history li')).toHaveCount(2);
    await expect(drawer).toContainText('待执行 → 已完成');
    await expect(drawer).toContainText('林设计');
    await drawer.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '记录状态看板', exact: true }).click();
    await expect(card).toContainText('已完成');
    await board.getByLabel('看板状态筛选', { exact: true }).selectOption('已完成');
    await expect(board.locator('.record-card')).toHaveCount(1);
    await board.getByLabel('搜索看板记录', { exact: true }).fill('业主已确认');
    await expect(board.locator('.record-card')).toHaveCount(1);
    await board.getByLabel('搜索看板记录', { exact: true }).fill('');
    await board.getByLabel('看板状态筛选', { exact: true }).selectOption('');
    await board.getByLabel('看板排序', { exact: true }).selectOption('dateDesc');
    expect(await lane.locator('.record-card').first().textContent()).toContain('复核厨房');
    await board.getByLabel('看板分组', { exact: true }).selectOption('status');
    await expect(board.locator('.board-lane')).toHaveCount(7);
    await board.getByLabel('看板分组', { exact: true }).selectOption('project');
    const lanes = board.locator('.board-lanes');
    await lanes.evaluate((e) => (e.scrollLeft = 250));
    expect(await lanes.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    await lanes.evaluate((e) => (e.scrollLeft = 0));
    await card.click();
    await drawer.getByLabel('记录备注', { exact: true }).fill('尚未保存的草稿');
    // Desktop keeps navigation accessible beside the drawer; mobile uses its visible Cancel.
    if (width >= 700) await page.getByRole('button', { name: '采购管理', exact: true }).click();
    else await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
    await page
      .getByRole('dialog', { name: '放弃未保存的修改？' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '记录状态看板', exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
    await page
      .getByRole('dialog', { name: '放弃未保存的修改？' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await expect(drawer.getByLabel('记录备注', { exact: true })).toHaveValue('尚未保存的草稿');
    await drawer.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    await page
      .getByRole('dialog', { name: '放弃未保存的修改？' })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await mkdir(
      process.env.CHUNMO_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/record-board',
      { recursive: true },
    );
    await page.screenshot({
      path: `${process.env.CHUNMO_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/record-board'}/board-${width}.png`,
      animations: 'disabled',
    });
    await card.click();
    await expect(drawer.getByLabel('记录备注', { exact: true })).toHaveValue(
      '核对高度，保留全部字段',
    );
    await page.screenshot({
      path: `${process.env.CHUNMO_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/record-board'}/drawer-${width}.png`,
      animations: 'disabled',
    });
    await drawer.getByRole('button', { name: '删除记录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '删除这条记录？' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await expect(card).toBeVisible();
    await drawer.getByRole('button', { name: '删除记录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '删除这条记录？' })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await expect(lane.locator('.lane-count')).toHaveText('1');
    await board
      .locator('.board-tool-primary')
      .getByRole('button', { name: '新增记录', exact: true })
      .click();
    await expect(drawer.getByLabel('记录所属项目', { exact: true })).toBeEnabled();
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
test.describe('record board touch device', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('touch create and save uses visible controls; local browser data stays untouched', async ({
    page,
    context,
  }) => {
    const f = await fixtureAccounts();
    await login(page, f.login, f.password);
    await seed(context);
    await page.reload();
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name),
    );
    await page.getByRole('button', { name: '记录状态看板', exact: true }).tap();
    await page
      .locator('.board-tool-primary')
      .getByRole('button', { name: '新增记录', exact: true })
      .tap();
    await page.getByLabel('记录所属项目', { exact: true }).selectOption('p-home');
    await page.getByLabel('任务事项', { exact: true }).fill('手机现场跟进');
    await page.getByLabel('记录状态', { exact: true }).selectOption('紧急');
    await page.getByRole('button', { name: '保存记录', exact: true }).tap();
    await expect(
      page.getByRole('button', { name: '打开记录：手机现场跟进', exact: true }),
    ).toContainText('紧急');
    expect(
      await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)),
    ).toEqual(databases);
  });
});
test('record board: two accounts receive SSE changes, preserve dirty drafts and recover conflicts', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    c = await browser.newContext(),
    peer = await browser.newContext();
  try {
    const a = await c.newPage(),
      b = await peer.newPage();
    await login(a, f.login, f.password);
    await seed(c);
    await login(b, f.employee, f.password);
    await a.reload();
    for (const p of [a, b])
      await p.getByRole('button', { name: '记录状态看板', exact: true }).click();
    const title = '栖桐里 · 理想之家 · 确认现场收口与成品保护';
    for (const p of [a, b])
      await p.getByRole('button', { name: '打开记录：' + title, exact: true }).click();
    await b.getByLabel('记录跟进', { exact: true }).fill('员工尚未提交的现场反馈');
    await a.getByLabel('记录状态', { exact: true }).selectOption('已完成');
    await a.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(b.locator('.record-stale')).toBeVisible();
    await expect(b.getByLabel('记录跟进', { exact: true })).toHaveValue('员工尚未提交的现场反馈');
    await b.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(b.locator('.record-drawer').getByRole('alert')).toContainText('其他人更新');
    await b.getByRole('button', { name: '重新读取已保存版本', exact: true }).click();
    await b
      .getByRole('dialog', { name: '重新读取并放弃当前草稿？' })
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await expect(b.getByLabel('记录状态', { exact: true })).toHaveValue('已完成');
    await b.getByLabel('记录跟进', { exact: true }).fill('员工确认收尾');
    await b.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(a.getByRole('button', { name: '打开记录：' + title, exact: true })).toContainText(
      '员工确认收尾',
    );
    const workspace = await (await api(c, '/workspace')).json();
    expect(workspace.revision).toBe(1);
  } finally {
    await c.close();
    await peer.close();
  }
});
for (const width of [1440, 390])
  test(`personal card ${width}: photo click opens existing picker; card/system images survive reload independently`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await pool.query('UPDATE account SET display_name=$1 WHERE id=$2', ['林设计', f.employeeId]);
    await login(page, f.employee, f.password);
    const image = (red: number, green: number) => {
      const p = new PNG({ width: 20, height: 20 });
      for (let i = 0; i < p.data.length; i += 4) {
        p.data[i] = red;
        p.data[i + 1] = green;
        p.data[i + 2] = 40;
        p.data[i + 3] = 255;
      }
      return PNG.sync.write(p);
    };
    const system = image(70, 150);
    expect(
      (
        await api(context, '/auth/avatar', 'PUT', {
          image: 'data:image/png;base64,' + system.toString('base64'),
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    const before = await (await context.request.get('/api/auth/session')).json();
    await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '点击更换名片照片', exact: true }).click();
    const chooser = await picker;
    await chooser.setFiles({ name: 'card.png', mimeType: 'image/png', buffer: image(150, 90) });
    const card = page.getByRole('dialog', { name: '我的个人名片', exact: true });
    await expect(card.getByRole('img', { name: '名片头像预览' }).locator('img')).toBeVisible();
    await card.getByRole('button', { name: '保存头像', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('头像已保存');
    const after = await (await context.request.get('/api/auth/session')).json();
    expect(after.user.avatarVersion).toBe(before.user.avatarVersion);
    expect(after.user.cardAvatarVersion).toBeTruthy();
    await expect(card.locator('.member-card-photo img')).toHaveAttribute('src', /card-avatar/);
    await card.getByText('名片头像设置', { exact: true }).click();
    await card.locator('.modal-body').evaluate((e) => (e.scrollTop = 0));
    await page.screenshot({
      path: `${process.env.CHUNMO_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/record-board'}/personal-card-${width}.png`,
      animations: 'disabled',
    });
    await card.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
    await expect(card.locator('.member-card-photo img')).toHaveAttribute(
      'src',
      new RegExp(after.user.cardAvatarVersion),
    );
    await card.getByRole('button', { name: '账号设置', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login(page, f.employee, f.password);
    await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
    await expect(card.locator('.member-card-photo img')).toHaveAttribute(
      'src',
      new RegExp(after.user.cardAvatarVersion),
    );
    const signedInAgain = await (await context.request.get('/api/auth/session')).json();
    expect(signedInAgain.user.avatarVersion).toBe(before.user.avatarVersion);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
