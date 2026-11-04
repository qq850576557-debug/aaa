import { test, expect } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
for (const width of [1440, 390])
  test(`purchase manual date history and compact owner editor ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await page.goto('/');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.evaluate(
      async (data) => {
        const session = await (await fetch('/api/auth/session')).json();
        const state = await (await fetch('/api/workspace')).json();
        const r = await fetch('/api/workspace', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
          body: JSON.stringify({ revision: state.revision, data }),
        });
        if (!r.ok) throw new Error(await r.text());
      },
      (() => {
        const d = fixture();
        d.purchases = [
          { ...d.purchases[0], name: '电线及线管', due: '2026-11-04', taskId: '', leadDays: 0 },
        ];
        return d;
      })(),
    );
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    for (const due of ['2026-11-10', '2026-11-08']) {
      await page.getByRole('button', { name: '编辑采购电线及线管', exact: true }).first().click();
      const modal = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
      await expect(modal.getByLabel('事项负责人', { exact: true })).toHaveValue('张师傅');
      await expect(modal.getByText('同时@负责人', { exact: true })).toHaveCount(0);
      const box = (await modal.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(402);
      expect(box.x).toBeGreaterThanOrEqual(0);
      await modal.getByLabel('采购截止日期', { exact: true }).fill(due);
      await modal.getByRole('button', { name: '保存', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(page.locator('.save-state')).toContainText('已保存');
    }
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    await page.getByRole('button', { name: '编辑采购电线及线管', exact: true }).first().click();
    const modal = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
    await expect(modal.getByLabel('采购截止日期', { exact: true })).toHaveValue('2026-11-08');
    await modal.getByRole('button', { name: '查看采购日期变更记录', exact: true }).focus();
    const tooltip = modal.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('延期至2026.11.10');
    await expect(tooltip).toContainText('提前至2026.11.08');
    const deletion = modal.getByRole('button', { name: '删除', exact: true });
    const padding = await deletion.evaluate((e) => getComputedStyle(e).paddingInlineStart);
    expect(parseFloat(padding)).toBeGreaterThanOrEqual(10);
    await page.screenshot({ path: `/tmp/purchase-date-editor-${width}.png`, fullPage: true });
  });
