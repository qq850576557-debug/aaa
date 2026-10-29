import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
const screenshots =
  process.env.CHUNMO_UI_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/ui-hierarchy';
async function api(context: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const session = await (await context.request.get('/api/auth/session')).json();
  return context.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': session.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function login(page: Page, login: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
for (const width of [1440, 1280, 390])
  test(`UI hierarchy cloud ${width}: compact controls, distinct project themes and working drawer`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await login(page, f.login, f.password);
    const d = fixture();
    d.projects.push(
      ...['云杉庭', '溪岸居', '星河里', '南山院', '望月台'].map((name, i) => ({
        ...d.projects[0],
        id: 'theme-' + i,
        name,
      })),
    );
    expect((await api(context, '/workspace', 'PUT', { revision: 0, data: d })).status()).toBe(200);
    for (const p of d.projects.slice(0, 5))
      expect(
        (
          await api(context, '/records', 'POST', {
            requestId: randomUUID(),
            value: {
              projectId: p.id,
              title: '现场收口与成品保护复核',
              nodeDate: '2026-11-02',
              status: '持续跟进',
              notes: '核对材料规格、施工图与现场尺寸。',
              followUp: '待现场复核后记录确认结果。',
            },
          })
        ).status(),
      ).toBe(200);
    const before = await (await api(context, '/workspace')).json();
    await page.reload();
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    const board = page.getByRole('region', { name: '事项管理', exact: true });
    await expect(board.locator('.board-lane')).toHaveCount(6);
    await expect(page.locator('.workspace-status-group,.local-notice')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '事项与备忘', exact: true })).toHaveCount(0);
    const search = board.getByLabel('搜索看板记录', { exact: true }),
      add = board.locator('.board-tool-primary > button');
    await expect(board.locator('.board-tool-primary > button + .board-search')).toBeVisible();
    const searchBox = (await search.boundingBox())!,
      addBox = (await add.boundingBox())!;
    expect(searchBox.width).toBeLessThanOrEqual(210);
    expect(Math.abs(searchBox.y - addBox.y)).toBeLessThanOrEqual(1);
    expect(searchBox.x).toBeGreaterThanOrEqual(addBox.x + addBox.width);
    if (width >= 1280) {
      const filters = (await board.locator('.board-filters').boundingBox())!;
      expect(Math.abs(filters.y - addBox.y)).toBeLessThanOrEqual(1);
      const title = (await page.locator('.page-heading h1').boundingBox())!,
        subtitle = (await page.locator('.page-heading p').boundingBox())!;
      expect(subtitle.x).toBeGreaterThan(title.x + title.width);
      expect(subtitle.y).toBeLessThan(title.y + title.height);
    }
    const themes = await board.locator('.board-lane').evaluateAll((es) =>
      es.map((e) => ({
        lane: getComputedStyle(e).backgroundColor,
        tag: getComputedStyle(e.querySelector('h2')!).backgroundColor,
        border: getComputedStyle(e).borderColor,
      })),
    );
    expect(new Set(themes.map((x) => x.lane)).size).toBe(6);
    expect(new Set(themes.map((x) => x.tag)).size).toBe(6);
    themes.forEach((x) => expect(x.tag).not.toBe(x.lane));
    const first = board.locator('.board-lane').first(),
      theme = themes[0];
    await board.getByLabel('看板项目筛选', { exact: true }).selectOption(d.projects[0].id);
    expect(await first.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(theme.lane);
    await board.getByLabel('看板项目筛选', { exact: true }).selectOption('');
    await search.fill('不存在的搜索');
    await expect(board.locator('.record-card')).toHaveCount(0);
    await search.fill('');
    await expect(board.locator('.record-card')).toHaveCount(5);
    const lanes = board.locator('.board-lanes');
    await lanes.evaluate((e) => (e.scrollLeft = 250));
    expect(await lanes.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    await lanes.evaluate((e) => (e.scrollLeft = 0));
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: `${screenshots}/board-${width}.png`,
      animations: 'disabled',
    });
    await first.locator('.record-card').click();
    const drawer = page.locator('.record-drawer');
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () => {
        const box = (await drawer.boundingBox())!;
        return Math.round(box.x + box.width);
      })
      .toBe(width);
    const bounds = (await drawer.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBe(width);
    await drawer.getByLabel('记录跟进', { exact: true }).fill('现场核验完成，等待业主确认。');
    await page.screenshot({
      path: `${screenshots}/drawer-${width}.png`,
      animations: 'disabled',
    });
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(first.locator('.record-card')).toContainText('现场核验完成');
    await first.locator('.record-card').click();
    await drawer.getByRole('tab', { name: '历史', exact: true }).click();
    await expect(drawer.locator('.record-history li')).toHaveCount(2);
    await drawer.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    const after = await (await api(context, '/workspace')).json();
    expect(after.data).toEqual(before.data);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
