import { test, expect } from '@playwright/test';
import { boot, restore, fixture, state, closeToast } from './helpers';
test('local navigation expansion survives refresh and page switches; personnel statistics are hidden', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  const toggle = page.getByRole('button', { name: '展开或收起项目菜单' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.locator('.stats-grid')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});
test('trade assignment reuses IDs and synchronizes multiple workers and personnel history', async ({
  page,
}) => {
  const d = fixture();
  d.people = ['张师傅', '李师傅'].map((name, i) => ({
    id: `w${i}`,
    name,
    role: '施工人员',
    trade: '水电',
    notes: '',
    active: true,
  }));
  await boot(page);
  await restore(page, d);
  await closeToast(page);
  await page.getByRole('button', { name: '安排水电改造施工人员', exact: true }).click();
  const f = page.getByRole('dialog');
  await f.getByLabel('分配施工人员张师傅', { exact: true }).check();
  await f.getByLabel('分配施工人员李师傅', { exact: true }).check();
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).trades[1].staffIds).toEqual(['w0', 'w1']);
  await expect(page.getByRole('button', { name: '安排水电改造施工人员' })).toContainText(
    '张师傅、李师傅',
  );
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  const card = page.locator('[data-person-id="w0"]');
  await card.locator('.staff-projects summary').click();
  await expect(card).toContainText('水电定位与布线');
  await expect(card).toContainText('2026-10-26');
});
