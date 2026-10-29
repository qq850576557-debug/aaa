import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
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
for (const width of [1440, 1280, 390])
  test(`shared UI ${width}: page shell and typography do not shift; scoped names and dialogs`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await login(page, f.login, f.password);
    const d = fixture();
    d.projects.push({ ...d.projects[0], id: 'project-b', name: '云杉庭 · 二号工地' });
    expect((await api(context, '/workspace', 'PUT', { revision: 0, data: d })).status()).toBe(200);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const geometry = async () =>
      page.locator('main,.topbar,.sidebar,.page-heading h1').evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect(),
            s = getComputedStyle(e);
          return {
            selector: e.tagName + (e.className || ''),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: e.tagName === 'H1' ? null : Math.round(r.width),
            font: s.fontSize,
            pad: s.padding,
          };
        }),
      );
    const baseline = await geometry();
    for (const [name, menu] of [
      ['purchases', '采购管理'],
      ['records', '记录状态看板'],
      ['reminders', '提醒中心'],
      ['completed', '已完工项目'],
      ['people', '人员管理'],
      ['materials', '材料资产管理'],
      ['home', '项目工作空间'],
    ] as const) {
      await page.getByRole('button', { name: menu, exact: true }).click();
      await expect(page.locator('.page-heading h1')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const actual = await geometry();
      expect(actual).toEqual(baseline);
      if (name === 'materials')
        await page.getByLabel('材料项目', { exact: true }).selectOption(d.projects[0].id);
      if (name === 'purchases') {
        await expect(page.locator('.purchase-list')).not.toContainText(d.projects[0].name);
        await expect(page.locator('.project-context')).toContainText(d.projects[0].name);
      }
      if (name === 'records') {
        await expect(page.locator('.board-lanes')).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 1440) {
        await mkdir('/tmp/chunmo-regression-screenshots/home-agenda', { recursive: true });
        await page.screenshot({
          path: `/tmp/chunmo-regression-screenshots/home-agenda/page-${name}-1440.png`,
          animations: 'disabled',
        });
      }
    }
    await page
      .getByTestId('tomorrow-panel')
      .getByRole('button', { name: '添加明日事项', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '新建每日事项', exact: true });
    await expect(dialog.getByLabel('计划日期', { exact: true })).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `/tmp/chunmo-regression-screenshots/home-agenda/tomorrow-editor-${width}.png`,
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  });
test('cloud agenda: employee note changes persist across accounts and re-login, keep project scope and procurement intact', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const owner = await a.newPage(),
      staff = await b.newPage();
    await login(owner, f.login, f.password);
    const d = fixture();
    d.notes = [];
    d.projects.push({ ...d.projects[0], id: 'other', name: '其他工地' });
    await api(a, '/workspace', 'PUT', { revision: 0, data: d });
    const before = await (await api(a, '/workspace')).json();
    await login(staff, f.employee, f.password);
    const tomorrow = staff.getByTestId('tomorrow-panel');
    await tomorrow.getByRole('button', { name: '添加明日事项', exact: true }).click();
    const form = staff.getByRole('dialog', { name: '新建每日事项', exact: true });
    await form.getByLabel('事项标题', { exact: true }).fill('员工安排明日复核');
    const planned = await form.getByLabel('计划日期', { exact: true }).inputValue();
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(staff.locator('.save-state')).toContainText('已保存');
    await owner.reload();
    await expect(owner.getByTestId('tomorrow-panel')).toContainText('员工安排明日复核');
    const after = await (await api(a, '/workspace')).json();
    expect(after.data.notes).toHaveLength(1);
    expect(after.data.notes[0]).toMatchObject({ projectId: d.projects[0].id, date: planned });
    expect(after.data.purchases).toEqual(before.data.purchases);
    expect(after.data.tasks).toEqual(before.data.tasks);
    await staff.getByRole('button', { name: '完成员工安排明日复核', exact: true }).click();
    await expect(staff.locator('.save-state')).toContainText('已保存');
    await staff.getByRole('button', { name: '账号管理', exact: true }).click();
    await staff.getByRole('button', { name: '退出登录', exact: true }).click();
    await login(staff, f.employee, f.password);
    await expect(staff.getByTestId('tomorrow-panel').locator('.note-card')).toHaveClass(/done/);
    if (await staff.locator('.mobile-project-toggle').isVisible())
      await staff.locator('.mobile-project-toggle').click();
    await staff.locator('.sidebar-project-list [data-project-id="other"]').click();
    await expect(staff.getByTestId('tomorrow-panel')).not.toContainText('员工安排明日复核');
  } finally {
    await a.close();
    await b.close();
  }
});
