import { test, expect } from '@playwright/test';
import { boot, restore, fixture, state, closeToast } from './helpers';
test('desktop toolbar retains exactly 50 steps, ordered redo, native input undo and clears redo on a new edit', async ({
  page,
}) => {
  test.setTimeout(180000);
  await boot(page);
  await restore(page, fixture());
  await closeToast(page);
  const undo = page
    .locator('.business-undo-controls')
    .getByRole('button', { name: '撤销', exact: true });
  const redo = page.getByRole('button', { name: '重做', exact: true });
  await expect(undo).toBeDisabled();
  for (let i = 1; i <= 51; i++) {
    await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
    await dialog.getByLabel('项目备注', { exact: true }).fill('有效编辑' + i);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(undo).toHaveAttribute('title', /50\/50/);
  const scroll = await page.evaluate(() => scrollY);
  for (let i = 0; i < 50; i++) await undo.click();
  await expect(undo).toBeDisabled();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).projects[0].notes).toBe('有效编辑1');
  for (let i = 0; i < 50; i++) await redo.click();
  await expect(redo).toBeDisabled();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await state(page)).projects[0].notes).toBe('有效编辑51');
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
  const input = dialog.getByLabel('项目备注', { exact: true });
  await input.pressSequentially('追加');
  await input.press('Control+z');
  await expect(undo).toHaveAttribute('title', /50\/50/);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const discard = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
  if (await discard.isVisible())
    await discard.getByRole('button', { name: '确认操作', exact: true }).click();
  await page.locator('.brand-name').first().click();
  await page.keyboard.press('Control+z');
  await expect(redo).toBeEnabled();
  await page.keyboard.press('Control+Shift+z');
  await expect(redo).toBeDisabled();
  await undo.click();
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await edit.getByLabel('项目备注', { exact: true }).fill('新分支');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(redo).toBeDisabled();
});
