import { test, expect, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';

async function assertForeground(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const inspect = (node: Element) => {
          const style = getComputedStyle(node);
          return !/blur\(|url\(/.test(style.filter) && style.backdropFilter === 'none';
        };
        let parent: Element | null = element;
        while (parent) {
          if (!inspect(parent)) return false;
          parent = parent.parentElement;
        }
        return [...element.querySelectorAll('h2, input, select, textarea, button, img, svg')]
          .filter((node) => node.closest('dialog') === element)
          .every(inspect);
      }),
    )
    .toBe(true);
}

test('desktop glass separates visible account and nested foreground; rectangular photo preserves every corner', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const output = process.env.CHUNMO_GLASS_SCREENSHOTS || info.outputDir;
  await mkdir(output, { recursive: true });
  const save = (name: string) =>
    page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' });
  const f = await fixtureAccounts();
  await page.goto('/');
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    'href',
    '/brand/favicon-32.png',
  );
  const icon = await page.request.get('/brand/favicon-32.png');
  expect(PNG.sync.read(await icon.body()).data[3]).toBe(0);
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');

  const header = {
    Origin: 'http://127.0.0.1:5180',
    'X-CSRF-Token': (await (await page.request.get('/api/auth/session')).json()).csrf,
  };
  const image = new PNG({ width: 900, height: 1120 });
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      const corner = (y < image.height / 2 ? 0 : 2) + (x < image.width / 2 ? 0 : 1);
      const colors = [
        [177, 71, 59],
        [66, 121, 83],
        [73, 106, 186],
        [213, 175, 47],
      ];
      image.data.set([...colors[corner], 255], offset);
    }
  const bytes = PNG.sync.write(image);
  const put = (path: string, data: unknown) =>
    page.request.put('/api' + path, { data, headers: header });
  expect(
    (
      await put('/auth/card-avatar', { image: 'data:image/png;base64,' + bytes.toString('base64') })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await put('/member-cards/me', {
        displayName: '春茉验收负责人',
        englishName: 'Chunmo',
        joinedOn: '2021-03-11',
      })
    ).ok(),
  ).toBe(true);
  expect((await put('/workspace', { revision: 0, data: fixture() })).ok()).toBe(true);
  await page.reload();
  const ownTrigger = page.getByRole('button', { name: '打开我的个人名片', exact: true });
  await ownTrigger.click();
  const own = page.getByRole('dialog', { name: '我的个人名片', exact: true });
  await expect(own).toHaveAttribute('data-cm-glass', 'frosted');
  for (const label of ['账号设置', '部门管理', '更换照片'])
    await expect(own.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await assertForeground(own);
  const photo = own.locator('.member-card-photo img');
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((el) => (el as HTMLImageElement).naturalHeight))
    .toBe(1120);
  const bounds = await photo.evaluate((el) => {
    const img = el as HTMLImageElement;
    const box = img.getBoundingClientRect();
    const modal = img.closest('dialog')!;
    const controls = [...modal.querySelectorAll('.modal-head button')].map((e) =>
      e.getBoundingClientRect(),
    );
    return {
      ratio: box.width / box.height,
      imageRatio: img.naturalWidth / img.naturalHeight,
      top: box.top,
      gap: modal.querySelector('.member-card-content')!.getBoundingClientRect().top - box.bottom,
      controls: controls.map((r) => ({ y: r.y, bottom: r.bottom, left: r.left, right: r.right })),
      modalRight: modal.getBoundingClientRect().right,
      radii: [img, img.parentElement!, img.closest('button')!].map(
        (node) => getComputedStyle(node).borderRadius,
      ),
      clip: getComputedStyle(img.parentElement!).clipPath,
    };
  });
  expect(bounds.ratio).toBeCloseTo(bounds.imageRatio, 3);
  expect(bounds.radii).toEqual(['0px', '0px', '0px']);
  expect(bounds.clip).toBe('none');
  expect(Math.abs(bounds.gap)).toBeLessThanOrEqual(2);
  expect(bounds.controls).toHaveLength(1);
  expect(Math.max(...bounds.controls.map((r) => r.bottom))).toBeLessThanOrEqual(bounds.top + 1);
  expect(bounds.modalRight - bounds.controls.at(-1)!.right).toBeLessThan(24);
  const photoPixels = PNG.sync.read(await photo.screenshot());
  const pixel = (x: number, y: number) =>
    Array.from(
      photoPixels.data.subarray(
        (y * photoPixels.width + x) * 4,
        (y * photoPixels.width + x) * 4 + 3,
      ),
    );
  const corners = [
    pixel(5, 5),
    pixel(photoPixels.width - 6, 5),
    pixel(5, photoPixels.height - 6),
    pixel(photoPixels.width - 6, photoPixels.height - 6),
  ];
  corners.forEach((rgb, index) =>
    rgb.forEach((channel, col) => {
      expect(
        Math.abs(
          channel -
            [
              [177, 71, 59],
              [66, 121, 83],
              [73, 106, 186],
              [213, 175, 47],
            ][index][col],
        ),
      ).toBeLessThan(10);
    }),
  );
  await save('personal-card');
  await own.getByRole('button', { name: /查看.*名片照片大图/ }).click();
  const preview = page.getByRole('dialog', { name: '名片照片预览' });
  await expect(preview).toHaveAttribute('data-cm-glass', 'frosted');
  await assertForeground(preview);
  await expect(page.locator('.cm-glass-layer')).toHaveCount(0);
  await expect(preview.getByRole('img', { name: '春茉验收负责人的名片照片' })).toBeVisible();
  await save('nested-photo-preview');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await own.getByRole('button', { name: /编辑.*名片/ }).click();
  const cardForm = page.getByRole('dialog', { name: /编辑名片 ·/ });
  await assertForeground(cardForm);
  await cardForm.getByRole('button', { name: '更换照片', exact: true }).hover();
  await save('personal-card-editor');
  await cardForm.getByRole('button', { name: '选择入职日期' }).click();
  const dateMenu = page.getByRole('dialog', { name: '入职日期日历' });
  await expect(dateMenu).toBeVisible();
  await expect(dateMenu).toHaveCSS('filter', 'none');
  await save('card-date-menu');
  await page.keyboard.press('Escape');
  await expect(dateMenu).toBeHidden();
  await expect(cardForm).toBeVisible();
  await cardForm.getByRole('button', { name: '关闭浮窗' }).click();
  await own.getByRole('button', { name: '关闭浮窗' }).click();
  await expect(ownTrigger).toBeFocused();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const account = page.getByRole('dialog', { name: '账号管理', exact: true });
  await assertForeground(account);
  await expect(account.getByLabel('我的展示名称', { exact: true })).toHaveValue('春茉验收负责人');
  await expect(page.locator('.cm-glass-layer')).toHaveCount(0);
  await account.getByLabel('我的展示名称', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(account.getByRole('button', { name: '保存展示名称' })).toBeFocused();
  await save('account-management-focus');
  for (const tab of ['账号通讯录', '操作记录', '备份导入', '账号与安全']) {
    await account.getByRole('tab', { name: tab }).click();
    await expect(account.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    await assertForeground(account);
    await save('account-' + tab);
    if (tab === '账号通讯录') {
      await account.getByRole('button', { name: '部门管理' }).click();
      const dept = page.getByRole('dialog', { name: '部门管理', exact: true });
      await assertForeground(dept);
      await dept.getByRole('button', { name: '新增部门' }).click();
      const deptEdit = page.getByRole('dialog', { name: '新增部门', exact: true });
      await assertForeground(deptEdit);
      await deptEdit.getByLabel('部门名称', { exact: true }).fill('测试设计部');
      await save('department-form');
      await deptEdit.getByRole('button', { name: '关闭浮窗' }).click();
      await dept.getByRole('button', { name: '关闭浮窗' }).click();
    }
  }
  await page.keyboard.press('Escape');
  await expect(account).toHaveCount(0);

  for (const [trigger, title, file] of [
    ['账号管理', '账号管理', 'account-topbar'],
    ['新建项目', '新建项目', 'project-form'],
    ['历史版本', /历史/, 'history-menu'],
    ['我的@消息', /消息/, 'mention-menu'],
    ['下载数据', '数据与备份', 'backup-dialog'],
    ['添加今日事项', '新增记录', 'agenda-form'],
    ['查看排班', '值日排班', 'duty-calendar'],
  ] as const) {
    await page.getByRole('button', { name: trigger, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title }).last();
    await assertForeground(dialog);
    await save(file);
    await dialog.getByRole('button', { name: '关闭浮窗' }).click();
    await expect(dialog).toHaveCount(0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    'href',
    '/brand/favicon-circle-v12.png',
  );
});
