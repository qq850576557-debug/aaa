import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { pool, privatePool } from '../server/db';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function api(c: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await c.request.get('/api/auth/session')).json();
  return c.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function enter(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
for (const width of [1440, 390])
  test(`compact ${width}: aligned fields/grants, bilingual member card, private join date and owner departments`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts(),
      owner = await browser.newContext({ viewport: { width, height: 950 } }),
      staff = await browser.newContext();
    try {
      const a = await owner.newPage();
      await enter(a, f.login, f.password);
      await api(owner, '/workspace', 'PUT', { revision: 0, data: fixture() });
      await a.reload();
      await a.getByRole('button', { name: '人员管理', exact: true }).click();
      const filters = a.locator('.assessment-filters');
      await expect(filters.getByLabel('考核项目', { exact: true })).toBeVisible();
      const geometry = await filters.evaluate((e) =>
        [...e.children].map((label) => {
          const c = label.querySelector('select,.date-field')!;
          const r = c.getBoundingClientRect();
          return { top: label.getBoundingClientRect().top, control: r.top, h: r.height };
        }),
      );
      for (const g of geometry) expect(g.control - g.top).toBeCloseTo(25, 0);
      expect(new Set(geometry.map((g) => g.h)).size).toBe(1);
      await a.getByRole('button', { name: '考核记录人授权', exact: true }).click();
      const grant = a.getByRole('dialog', { name: '考核记录人授权', exact: true });
      const r = await grant
        .locator('.recorder-grant-row')
        .first()
        .evaluate((e) => {
          const a = e.querySelector('input')!.getBoundingClientRect(),
            b = e.querySelector('span')!.getBoundingClientRect();
          return {
            right: a.right,
            left: b.left,
            midA: a.y + a.height / 2,
            midB: b.y + b.height / 2,
          };
        });
      expect(r.right).toBeLessThan(r.left);
      expect(Math.abs(r.midA - r.midB)).toBeLessThan(2);
      await a.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await a.getByRole('button', { name: '账号管理', exact: true }).click();
      let panel = a.getByRole('dialog', { name: '账号管理', exact: true });
      await panel.getByRole('tab', { name: '账号通讯录', exact: true }).click();
      await panel.getByRole('button', { name: '部门管理', exact: true }).click();
      await a.getByRole('button', { name: '新增部门', exact: true }).click();
      let modal = a.getByRole('dialog', { name: '新增部门', exact: true });
      await modal.getByLabel('部门名称', { exact: true }).fill('设计中心');
      await modal.getByLabel('部门英文名称', { exact: true }).fill('Design Studio');
      await modal.getByRole('button', { name: '保存部门', exact: true }).click();
      await a
        .getByRole('dialog', { name: '部门管理', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      const card = panel.locator(`[data-member-id="${f.employeeId}"]`);
      await card.getByRole('button', { name: /编辑.*名片/ }).click();
      modal = a.getByRole('dialog', { name: /编辑名片 ·/ });
      await modal.getByLabel('名片中文姓名', { exact: true }).fill('陈设计');
      await modal.getByLabel('名片英文名', { exact: true }).fill('Chris CHEN');
      const departments = await (await api(owner, '/departments')).json();
      await modal
        .getByLabel('名片部门', { exact: true })
        .selectOption(departments.departments[0].id);
      await modal.getByLabel('入职日期', { exact: true }).fill('2020-09-01');
      await modal.getByRole('button', { name: '保存名片', exact: true }).click();
      await expect(card).toContainText('Chris CHEN');
      await expect(card).toContainText('Design Studio');
      await expect(card).toContainText('SJD春茉');
      await expect(card).toContainText('2020-09-01');
      await a.reload();
      await a.getByRole('button', { name: '账号管理', exact: true }).click();
      panel = a.getByRole('dialog', { name: '账号管理', exact: true });
      await panel.getByRole('tab', { name: '账号通讯录', exact: true }).click();
      await expect(panel.locator(`[data-member-id="${f.employeeId}"]`)).toContainText('Chris CHEN');
      const b = await staff.newPage();
      await enter(b, f.employee, f.password);
      await b.getByRole('button', { name: '账号管理', exact: true }).click();
      const sp = b.getByRole('dialog', { name: '账号管理', exact: true });
      await sp.getByRole('tab', { name: '账号通讯录', exact: true }).click();
      const mine = sp.locator(`[data-member-id="${f.employeeId}"]`);
      await expect(mine).toContainText('2020-09-01');
      await expect(sp.getByRole('button', { name: '部门管理', exact: true })).toHaveCount(0);
      await mine.getByRole('button', { name: '编辑陈设计名片', exact: true }).click();
      const self = b.getByRole('dialog', { name: '编辑名片 · 陈设计', exact: true });
      await expect(self.getByLabel('名片部门', { exact: true })).toHaveCount(0);
      await self.getByLabel('入职日期', { exact: true }).fill('2021-01-02');
      await self.getByRole('button', { name: '保存名片', exact: true }).click();
      await expect(mine).toContainText('2021-01-02');
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await panel.locator(`[data-member-id="${f.employeeId}"]`).scrollIntoViewIfNeeded();
      await a.screenshot({ path: `/tmp/chunmo-cards-${width}.png` });
    } finally {
      await owner.close();
      await staff.close();
    }
  });
