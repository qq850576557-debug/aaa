import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
const output = '/tmp/chunmo-photo-buttons';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
for (const width of [1440, 390])
  test(`photo and buttons ${width}: source validation, one crop workflow, retry, clear tools, independent profiles and all page controls`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 1000 });
    await mkdir(output, { recursive: true });
    const f = await fixtureAccounts();
    await page.goto('/');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    async function api(path = '/workspace', method = 'GET', data?: unknown) {
      const s = await (await context.request.get('/api/auth/session')).json();
      return context.request.fetch('/api' + path, {
        method,
        headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
        ...(data === undefined ? {} : { data }),
      });
    }
    expect((await api('/workspace', 'PUT', { revision: 0, data: fixture() })).status()).toBe(200);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const before = await (await api()).json(),
      identity = await (await api('/auth/session')).json();
    await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
    const card = page.getByRole('dialog', { name: '我的个人名片', exact: true });
    await expect(card.getByText('名片头像设置', { exact: true })).toHaveCount(0);
    await expect(card.locator('input[type=file]')).toHaveCount(1);
    const low = await sharp({
      create: { width: 1080, height: 719, channels: 3, background: '#8c9c83' },
    })
      .png()
      .toBuffer();
    await card
      .getByLabel('选择名片头像', { exact: true })
      .setInputFiles({ name: 'low.png', mimeType: 'image/png', buffer: low });
    await expect(card.getByRole('alert')).toContainText('短边至少为720px');
    for (const name of ['账号设置', '部门管理']) {
      const button = await card.getByRole('button', { name, exact: true }).boundingBox(),
        alert = await card.getByRole('alert').boundingBox();
      expect(button!.y + button!.height <= alert!.y || alert!.y + alert!.height <= button!.y).toBe(
        true,
      );
    }
    await page.screenshot({ path: `${output}/validation-${width}.png` });
    const data = Buffer.alloc(1600 * 1200 * 3);
    for (let y = 0; y < 1200; y++)
      for (let x = 0; x < 1600; x++) {
        let i = (y * 1600 + x) * 3;
        data[i] = Math.round((x / 1600) * 200);
        data[i + 1] = Math.round((y / 1200) * 180);
        data[i + 2] = 90;
      }
    const original = await sharp(data, { raw: { width: 1600, height: 1200, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const picker = page.waitForEvent('filechooser');
    await card.getByRole('button', { name: '点击更换名片照片', exact: true }).click();
    await (await picker).setFiles({ name: 'high.jpg', mimeType: 'image/jpeg', buffer: original });
    const crop = page.getByRole('dialog', { name: '调整头像照片', exact: true });
    await expect(crop).toBeVisible();
    const frame = crop.getByLabel('裁切效果预览'),
      r = await frame.boundingBox();
    await page.mouse.move(r!.x + r!.width * 0.5, r!.y + r!.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(r!.x + r!.width * 0.6, r!.y + r!.height * 0.4, { steps: 5 });
    await page.mouse.up();
    await crop.getByRole('button', { name: '放大照片', exact: true }).click();
    const zoom = await crop.getByLabel('照片缩放', { exact: true }).inputValue(),
      transform = await frame.locator('img').getAttribute('style');
    await page.screenshot({ path: `${output}/crop-${width}.png` });
    let requests = 0;
    let releaseFailure = () => {};
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    await page.route('**/api/auth/card-avatar', async (route) => {
      requests++;
      if (requests === 1) {
        await failureGate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '模拟临时保存失败' }),
        });
      } else await route.continue();
    });
    await crop.getByRole('button', { name: '保存头像', exact: true }).click();
    await expect(crop.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
    releaseFailure();
    await expect(crop.getByRole('alert')).toContainText('已保留照片和裁切位置');
    expect(await crop.getByLabel('照片缩放', { exact: true }).inputValue()).toBe(zoom);
    expect(await frame.locator('img').getAttribute('style')).toBe(transform);
    await crop.getByRole('button', { name: '保存头像', exact: true }).click();
    await expect(crop).toHaveCount(0);
    await expect(card.getByRole('status').filter({ hasText: '头像已保存' })).toContainText(
      '头像已保存',
    );
    expect(requests).toBe(2);
    await expect(card.locator('.member-card-photo img')).toHaveAttribute('src', /card-avatar/);
    const identityAfter = await (await api('/auth/session')).json();
    expect(identityAfter.user.avatarVersion).toBe(identity.user.avatarVersion);
    expect((await (await api()).json()).revision).toBe(before.revision);
    const bytes = await (await api('/accounts/' + f.id + '/card-avatar')).body(),
      dimensions = await sharp(bytes).metadata();
    expect(bytes.length).toBeLessThanOrEqual(524288);
    expect(dimensions.width).toBeGreaterThanOrEqual(720);
    const photoRatio = await card.locator('.member-card-photo').evaluate((e) => {
      const b = e.getBoundingClientRect();
      return b.width / b.height;
    });
    expect(Math.abs(dimensions.width! / dimensions.height! - photoRatio)).toBeLessThan(0.005);
    expect(
      await card.locator('.member-card-edit').evaluate((e) => getComputedStyle(e).borderRadius),
    ).toBe('999px');
    await page.screenshot({ path: `${output}/card-${width}.png` });
    await card.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
    await expect(card.locator('.member-card-photo img')).toHaveAttribute(
      'src',
      new RegExp(identityAfter.user.cardAvatarVersion),
    );
    await card.getByRole('button', { name: '关闭浮窗', exact: true }).click();
    const results = [];
    for (const name of [
      '项目工作空间',
      '事项管理',
      '采购管理',
      '提醒中心',
      '已完工项目',
      '人员管理',
      '材料资产管理',
    ]) {
      const nav = page
        .getByRole('navigation')
        .getByRole('button', { name: new RegExp('^' + name) });
      if (await nav.count()) await nav.first().click();
      else
        await page
          .getByRole('button', { name: new RegExp('^' + name) })
          .first()
          .click();
      const controls = await page.locator('button:visible').evaluateAll((es) =>
        es
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => ({
            text: e.getAttribute('aria-label') || e.textContent?.trim(),
            background: getComputedStyle(e).backgroundColor,
            transition: getComputedStyle(e).transitionDuration,
          })),
      );
      const transparent = controls.filter((c) => c.background === 'rgba(0, 0, 0, 0)');
      expect(transparent, JSON.stringify(transparent)).toHaveLength(0);
      results.push({ page: name, controls: controls.length });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const accountButton = page.getByRole('button', { name: '账号管理', exact: true });
    await accountButton.hover();
    await expect
      .poll(() => accountButton.evaluate((e) => getComputedStyle(e).translate))
      .toBe('0px -1px');
    await page.mouse.down();
    await expect.poll(() => accountButton.evaluate((e) => getComputedStyle(e).scale)).toBe('0.98');
    await page.mouse.up();
    await expect
      .poll(() => accountButton.evaluate((e) => ['none', '1'].includes(getComputedStyle(e).scale)))
      .toBe(true);
    await page
      .getByRole('dialog', { name: '账号管理', exact: true })
      .getByRole('button', { name: '关闭浮窗', exact: true })
      .click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page
        .getByRole('button', { name: '账号管理', exact: true })
        .evaluate((e) => getComputedStyle(e).transitionDuration),
    ).toBe('0s');
    await writeFile(`${output}/coverage-${width}.json`, JSON.stringify(results, null, 2));
  });
