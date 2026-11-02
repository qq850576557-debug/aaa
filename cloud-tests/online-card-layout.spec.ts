import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { PNG } from 'pngjs';

async function api(p: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return p.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
async function enter(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
for (const width of [1440, 390])
  test(`online card ${width}: same photo layout as self, read-only colleague and private-date isolation`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts();
    const a = await browser.newPage({ viewport: { width, height: 1000 } }),
      b = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await enter(a, f.login, f.password);
      await enter(b, f.employee, f.password);
      const department = await api(a, '/departments', 'POST', {
        name: '设计部',
        englishName: 'Design Department',
        active: true,
      });
      expect(department.status).toBe(201);
      expect(
        (
          await api(a, `/member-cards/${f.employeeId}`, 'PUT', {
            displayName: '名片同事',
            englishName: 'Steven',
            joinedOn: '2021-03-11',
            departmentId: department.value.id,
            jobTitle: '设计总监',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api(a, '/member-cards/me', 'PUT', {
            displayName: '名片负责人',
            englishName: 'Owner',
            joinedOn: '2019-06-21',
          })
        ).status,
      ).toBe(200);
      const image = new PNG({ width: 1080, height: 756 });
      image.data.fill(160);
      expect(
        (
          await api(b, '/auth/card-avatar', 'PUT', {
            image: 'data:image/png;base64,' + PNG.sync.write(image).toString('base64'),
          })
        ).status,
      ).toBe(200);
      await b.reload();
      await expect(b.locator('.save-state')).toContainText('已保存');
      await b.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      const own = b.getByRole('dialog', { name: '我的个人名片', exact: true });
      const photo = own.locator('.member-card-photo img');
      await expect(photo).toBeVisible();
      const source = await photo.getAttribute('src');
      const photoBox = (await own.locator('.member-card-photo').boundingBox())!;
      await expect(own).toContainText('Steven');
      await own.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await b
        .locator(`.online-accounts [data-account-id="${f.employeeId}"]`)
        .click({ timeout: 15000 });
      await expect(own).toBeVisible();
      await expect(own.locator('.member-card-photo img')).toHaveAttribute('src', source!);
      await expect(
        own.getByRole('button', { name: '点击更换名片照片', exact: true }),
      ).toBeVisible();
      await own.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await a
        .locator(`.online-accounts [data-account-id="${f.employeeId}"]`)
        .click({ timeout: 15000 });
      const colleague = a.getByRole('dialog', { name: '在线人员名片', exact: true });
      await expect(colleague.locator('.member-card-photo img')).toHaveAttribute('src', source!);
      await expect(colleague).toContainText('Steven');
      await expect(colleague).toContainText('设计总监');
      await expect(colleague).toContainText('Design Department');
      await expect(colleague).toContainText('SJD');
      await expect(colleague).toContainText('在线');
      await expect(colleague.locator('.member-card-edit,.member-photo-edit')).toHaveCount(0);
      await expect(colleague.getByRole('button', { name: '部门管理', exact: true })).toHaveCount(0);
      const box = (await colleague.locator('.member-card-photo').boundingBox())!;
      expect(box.width).toBeCloseTo(photoBox.width, 0);
      expect(box.height).toBeCloseTo(photoBox.height, 0);
      await a.screenshot({ path: `/tmp/online-card-photo-${width}.png` });
      await b.locator(`.online-accounts [data-account-id="${f.id}"]`).click({ timeout: 15000 });
      const restricted = b.getByRole('dialog', { name: '在线人员名片', exact: true });
      await expect(restricted).toContainText('名片负责人');
      await expect(restricted).not.toContainText('2019-06-21');
      await expect(restricted.locator('.member-card-joined')).toHaveCount(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
