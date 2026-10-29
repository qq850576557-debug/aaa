import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

test.afterAll(async () => {
  await pool.end();
});
for (const width of [1440, 1280, 390]) {
  test(`workbench visual acceptance ${width}`, async ({ page, context }) => {
    const f = await fixtureAccounts();
    await pool.query('UPDATE account SET display_name=$1 WHERE id=$2', ['林设计', f.id]);
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-29T02:00:00Z'));
    await page.goto('/');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const session = await (await context.request.get('/api/auth/session')).json();
    const d = fixture();
    d.projects.push({ ...d.projects[0], id: 'p-second', name: '云杉庭 · 生活提案' });
    d.people = [
      {
        id: 'worker',
        name: '张师傅',
        role: '施工人员',
        trade: '水电',
        active: true,
        notes: '负责现场水电施工',
      },
    ];
    const r = await context.request.put('/api/workspace', {
      headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': session.csrf },
      data: { revision: 0, data: d },
    });
    expect(r.status()).toBe(200);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const phase = process.env.CHUNMO_CAPTURE_BASELINE ? 'before' : 'after';
    const dir = 'docs/screenshots/record-board';
    await mkdir(dir, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `${dir}/${phase}-${name}-${width}.png`,
        animations: 'disabled',
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    };
    await capture('home');
    await page.locator('#project-timeline').scrollIntoViewIfNeeded();
    await capture('gantt');
    for (const [name, menu] of [
      ['purchase', '采购管理'],
      ['people', '人员管理'],
      ['materials', '材料资产管理'],
    ] as const) {
      await page.getByRole('button', { name: menu, exact: true }).click();
      await page.evaluate(() => scrollTo(0, 0));
      if (name === 'materials')
        await page.getByLabel('材料项目', { exact: true }).selectOption(d.projects[0].id);
      await capture(name);
    }
    await page.getByRole('button', { name: '账号管理', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '账号管理', exact: true })).toBeVisible();
    await capture('account');
    await page
      .getByRole('dialog', { name: '账号管理', exact: true })
      .getByRole('button', { name: '关闭浮窗', exact: true })
      .click();
    await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '我的个人名片', exact: true }).locator('.member-card'),
    ).toBeVisible();
    await capture('profile');
  });
}
