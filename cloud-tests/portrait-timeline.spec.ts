import { randomUUID } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
const output =
  process.env.CHUNMO_TIMELINE_VISUAL_OUTPUT || '/tmp/chunmo-regression-screenshots/timeline-ui';
async function api(c: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await c.request.get('/api/auth/session')).json();
  return c.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function login(p: Page, name: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(name);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
function photo(width: number, height: number) {
  const p = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      p.data[i] = 70 + Math.floor((x / width) * 100);
      p.data[i + 1] = 110 + Math.floor((y / height) * 90);
      p.data[i + 2] = 95;
      p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
}
for (const width of [1440, 390, 320])
  test(`portrait ${width}: original-ratio photo, blur, preview/error/retry, nested Esc and intact account permissions`, async ({
    page,
    context,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts(),
      owner = await browser.newContext(),
      op = await owner.newPage();
    try {
      await login(op, f.login, f.password);
      const seeded = fixture();
      seeded.projects.push(
        ...['云杉庭', '溪岸居'].map((name, i) => ({
          ...seeded.projects[0],
          id: 'portrait-project-' + i,
          name,
        })),
      );

      expect((await api(owner, '/workspace', 'PUT', { revision: 0, data: seeded })).status()).toBe(
        200,
      );
      expect(
        (
          await api(owner, '/departments', 'POST', {
            name: '设计中心',
            englishName: 'Design Studio',
            active: true,
          })
        ).status(),
      ).toBe(201);
      const departments = await (await api(owner, '/departments')).json();
      expect(
        (
          await api(owner, '/member-cards/' + f.employeeId, 'PUT', {
            displayName: '林知夏',
            englishName: 'Chris LIN',
            joinedOn: '2021-03-01',
            departmentId: departments.departments[0].id,
            jobTitle: '空间设计师',
          })
        ).status(),
      ).toBe(200);
      await login(page, f.employee, f.password);
      const before = await (await api(context, '/workspace')).json();
      for (const p of seeded.projects)
        expect(
          (
            await api(owner, '/records', 'POST', {
              requestId: randomUUID(),
              value: {
                projectId: p.id,
                title: p.name + ' · 收口复核',
                nodeDate: '2026-11-02',
                status: '持续跟进',
                notes: '核对图纸与现场尺寸。',
                followUp: '等待现场确认。',
              },
            })
          ).status(),
        ).toBe(200);
      await page.getByRole('button', { name: '事项管理', exact: true }).click();
      await expect(page.locator('.project-themed-lane')).toHaveCount(3);
      const colors = await page
        .locator('.project-themed-lane')
        .evaluateAll((es) =>
          es.map((e) => getComputedStyle(e).getPropertyValue('--project-hue').trim()),
        );
      expect(new Set(colors).size).toBe(3);
      const cardHue = await page
        .locator('[data-project-id="p-home"]')
        .getAttribute('data-project-hue');
      expect(colors[0]).toBe(cardHue);
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: `${output}/board-${width}.png`, animations: 'disabled' });
      await page.getByRole('button', { name: '项目工作空间', exact: true }).click();

      const sys = photo(1080, 1080);
      expect(
        (
          await api(context, '/auth/avatar', 'PUT', {
            image: 'data:image/png;base64,' + sys.toString('base64'),
          })
        ).status(),
      ).toBe(200);
      await page.reload();
      const identity = await (await api(context, '/auth/session')).json();
      await page.getByRole('button', { name: '点击姓名打开我的个人名片', exact: true }).click();
      const card = page.getByRole('dialog', { name: '我的个人名片', exact: true });
      await expect(card).toBeVisible();
      expect(await card.evaluate((e) => e.matches(':modal'))).toBe(true);
      const chooser = page.waitForEvent('filechooser');
      await card.getByRole('button', { name: '点击更换名片照片', exact: true }).click();
      await (
        await chooser
      ).setFiles({
        name: 'portrait-landscape.png',
        mimeType: 'image/png',
        buffer: photo(1600, 1000),
      });
      await expect(
        page.getByRole('dialog', { name: '调整头像照片', exact: true }).locator('img'),
      ).toBeVisible();
      await card.getByRole('button', { name: '保存头像', exact: true }).click();
      await expect(card.getByText('头像已保存', { exact: true })).toBeVisible();
      await expect(card.locator('.member-photo-preview .account-avatar')).toHaveAttribute(
        'data-image-state',
        'loaded',
      );
      const after = await (await api(context, '/auth/session')).json();
      expect(after.user.avatarVersion).toBe(identity.user.avatarVersion);
      const image = await sharp(
        Buffer.from(
          await (await api(context, '/accounts/' + f.employeeId + '/card-avatar')).body(),
        ),
      ).metadata();
      expect(image.width).toBe(1430);
      expect(image.height).toBe(1000);
      expect(
        (
          await sharp(
            await (await api(context, '/accounts/' + f.employeeId + '/avatar')).body(),
          ).metadata()
        ).width,
      ).toBe(1080);
      await expect(card.getByText('名片头像设置', { exact: true })).toHaveCount(0);
      await card.locator(':scope > .modal-body').evaluate((e) => (e.scrollTop = 0));
      const geo = await card.locator('.member-card-photo,.member-card-content').evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }),
      );
      expect(geo[1].y).toBeGreaterThanOrEqual(geo[0].y + geo[0].h);
      expect(Math.abs(geo[0].w - geo[1].w)).toBeLessThan(1);
      expect((await card.boundingBox())!.width).toBeLessThanOrEqual(360);
      expect(
        await card.evaluate((e) => getComputedStyle(e, '::backdrop').backdropFilter),
      ).toContain('blur');
      expect(await card.evaluate((e) => getComputedStyle(e).filter)).toBe('none');
      const type = await card
        .locator('.member-card-content h3,.member-card-english,.member-card-department')
        .evaluateAll((es) => es.map((e) => parseFloat(getComputedStyle(e).fontSize)));
      expect(type[0]).toBeGreaterThan(type[1]);
      expect(type[1]).toBeGreaterThan(type[2]);
      await expect(card).toContainText('空间设计师');
      await expect(card).toContainText('2021-03-01');
      await expect(card.getByRole('button', { name: '部门管理', exact: true })).toHaveCount(0);
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: `${output}/portrait-${width}.png`, animations: 'disabled' });
      await card.getByRole('button', { name: '查看林知夏名片照片大图', exact: true }).click();
      const lightbox = page.getByRole('dialog', { name: '名片照片预览', exact: true });
      await expect(lightbox.locator('img')).toBeVisible();
      await expect(lightbox).toContainText('原图 1430 × 1000');
      await page.screenshot({ path: `${output}/photo-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(lightbox).toHaveCount(0);
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: '编辑林知夏名片', exact: true }).click();
      const edit = page.getByRole('dialog', { name: '编辑名片 · 林知夏', exact: true });
      await expect(edit).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(edit).toHaveCount(0);
      await expect(card).toBeVisible();
      await page.route(
        '**/api/accounts/' + f.employeeId + '/card-avatar?*',
        (route) => route.abort(),
        { times: 1 },
      );
      await card.getByRole('button', { name: '查看林知夏名片照片大图', exact: true }).click();
      await expect(lightbox.getByRole('alert')).toContainText('照片暂时无法加载');
      await lightbox.getByRole('button', { name: '重新加载', exact: true }).click();
      await expect(lightbox.locator('img')).toBeVisible();
      await expect(lightbox).toContainText('原图 1430 × 1000');
      await page.keyboard.press('Escape');
      await expect(lightbox).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      await expect(card).toBeVisible();
      await page.mouse.click(2, 400);
      await expect(card).toHaveCount(0);
      await page.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      await card.getByRole('button', { name: '账号设置', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '账号管理', exact: true })).toBeVisible();
      const workspaceAfter = await (await api(context, '/workspace')).json();
      expect(workspaceAfter.data).toEqual(before.data);
      expect(
        (
          await api(context, '/accounts', 'POST', { login: 'forbidden', password: f.password })
        ).status(),
      ).toBe(403);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await op.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      const ownerCard = op.getByRole('dialog', { name: '我的个人名片', exact: true });
      await ownerCard.getByRole('button', { name: '部门管理', exact: true }).click();
      await expect(op.getByRole('dialog', { name: '部门管理', exact: true })).toBeVisible();
      await op.keyboard.press('Escape');
      await expect(ownerCard).toBeVisible();
    } finally {
      await owner.close();
    }
  });
