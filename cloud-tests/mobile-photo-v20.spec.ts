import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { fixtureAccounts } from '../server/test-fixtures';
import { signPlace } from '../server/photo-geocode';
async function setup(page: Page, context: any, manual = false) {
  await context.grantPermissions(['geolocation', 'camera']);
  await context.setGeolocation({ latitude: 30, longitude: 120, accuracy: 12 });
  const f = await fixtureAccounts();
  await page.goto('/?mobile=1');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.assistant-header')).toBeVisible();
  await page.route('**/api/site-photos/location', async (route) => {
    const { location } = route.request().postDataJSON();
    if (manual) {
      await route.fulfill({ json: { places: [], more: false } });
      return;
    }
    await route.fulfill({
      json: {
        places: [
          {
            id: 'test',
            name: '测试现场',
            address: '测试地址',
            distance: 80,
            receipt: signPlace(
              { id: f.id, workspaceId: f.workspaceId, login: f.login, owner: true },
              {
                location,
                placeName: '测试现场',
                placeSource: 'amap-poi-selected',
                nearby: true,
                poi: { id: 'test', latitude: 30, longitude: 120 },
                resolvedAt: new Date().toISOString(),
                expiresAt: new Date(Date.parse(location.obtainedAt) + 90000).toISOString(),
              },
            ),
          },
        ],
        more: false,
      },
    });
  });
  await page.evaluate(() => {
    (window as any).shares = [];
    (window as any).cancelShare = false;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (v: any) => {
        (window as any).shares.push(
          v.files.map((f: File) => ({ name: f.name, size: f.size, type: f.type })),
        );
        if ((window as any).cancelShare) throw new DOMException('cancel', 'AbortError');
      },
    });
  });
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '选择拍摄地址' })).toBeVisible();
  return f;
}
async function rows(page: Page) {
  return page.evaluate(async () => {
    const d = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('chunmo-photo-batches');
      r.onsuccess = () => resolve(r.result);
    });
    const data: any[] = await new Promise((resolve) => {
      const r = d.transaction('photos').objectStore('photos').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    d.close();
    return data.map((r) => ({
      meta: r.meta,
      ready: !!r.output,
      original: !!r.original,
      error: r.error,
      bytes: r.output ? Array.from(new Uint8Array(r.output)) : [],
    }));
  });
}
async function confirmNative(page: Page) {
  const wait = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '确认地址并拍摄' }).click();
  return wait;
}
const jpeg = () =>
  sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#bbcbaa' } })
    .jpeg()
    .toBuffer();
test('native camera opens after confirming address; batch share is explicit, durable, never uploaded and clears only after user confirmation', async ({
  page,
  context,
}) => {
  await setup(page, context);
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/site-photos$/.test(r.url())) uploads.push(r.url());
  });
  const bytes = await jpeg();
  await (
    await confirmNative(page)
  ).setFiles({ name: 'capture.jpg', mimeType: 'image/jpeg', buffer: bytes });
  const wait = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '继续拍摄', exact: true }).click();
  await (await wait).setFiles({ name: 'capture.jpg', mimeType: 'image/jpeg', buffer: bytes });
  await expect.poll(async () => (await rows(page)).filter((r) => r.ready).length).toBe(2);
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存本次照片' })).toBeEnabled();
  const data = await rows(page);
  expect(data.every((r) => !r.original)).toBe(true);
  const image = await sharp(Buffer.from(data[0].bytes)).metadata();
  expect([image.width, image.height]).toEqual([4000, 3000]);
  expect(Buffer.from(data[0].bytes).toString()).toContain('amap-poi-selected');
  await page.getByRole('button', { name: '保存本次照片' }).click();
  expect((await rows(page)).length).toBe(2);
  await expect(page.locator('.quick-photo').getByRole('status')).toContainText('副本仍保留');
  expect(await page.evaluate(() => (window as any).shares[0].length)).toBe(2);
  expect(
    await page.evaluate(() => new Set((window as any).shares[0].map((f: any) => f.name)).size),
  ).toBe(2);
  await page.getByRole('button', { name: '已确认存入相册，清理对应副本' }).click();
  await expect(page.locator('.quick-photo')).toHaveCount(0);
  expect((await rows(page)).length).toBe(0);
  expect(uploads).toEqual([]);
});
test('web continuous preview has fixed watermark, ten photos stay in session; share cancel and reload preserve output', async ({
  page,
  context,
}) => {
  await setup(page, context);
  const chooser = await confirmNative(page);
  await chooser.setFiles([]);
  await page.getByRole('button', { name: '网页连续拍摄' }).click();
  await expect(page.locator('.live-watermark')).toContainText('工地定位：测试现场');
  await expect(page.locator('.live-watermark')).not.toContainText('附近');
  for (let i = 1; i <= 10; i++) {
    await expect(page.locator('.camera-shutter')).toBeEnabled();
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.quick-camera-controls')).toContainText(`已拍 ${i} 张`);
  }
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect.poll(async () => (await rows(page)).filter((r) => r.ready).length).toBe(10);
  await page.evaluate(() => ((window as any).cancelShare = true));
  await page.getByRole('button', { name: '保存本次照片' }).click();
  await expect(page.locator('.quick-photo').getByRole('status')).toContainText('未确认保存');
  expect((await rows(page)).length).toBe(10);
  await page.reload();
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本次照片 10 张' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '选择拍摄地址' })).toHaveCount(0);
  expect((await rows(page)).every((r) => r.ready)).toBe(true);
});
test('GPS required and manual place kept separate; failed render retains original for export and retry', async ({
  page,
  context,
}) => {
  await setup(page, context, true);
  await page.getByLabel('手动地点名称').fill('自建房现场');
  await page.getByRole('button', { name: '使用此地点' }).click();
  const chooser = await confirmNative(page);
  await chooser.setFiles({
    name: 'invalid.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('invalid captured image'),
  });
  await expect.poll(async () => (await rows(page)).filter((r) => r.error).length).toBe(1);
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存本次照片' })).toBeDisabled();
  const data = await rows(page);
  expect(data[0].original).toBe(true);
  expect(data[0].meta.placeSource).toBe('user-manual');
  expect(data[0].meta.nearby).toBe(false);
  await expect(page.getByRole('button', { name: /重试水印处理/ })).toBeVisible();
});
test('denied GPS cannot confirm address or open a camera', async ({ page, context }) => {
  await setup(page, context);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_: unknown, fail: Function) => fail({ code: 1 }) },
    }),
  );
  let opened = false;
  page.on('filechooser', () => {
    opened = true;
  });
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '选择拍摄地址' })).toContainText('定位被拒绝');
  await expect(page.getByRole('button', { name: '确认地址并拍摄' })).toBeDisabled();
  expect(opened).toBe(false);
});
test('local quota failure keeps captured bytes on screen, blocks leaving and can recover by retrying durable save', async ({
  page,
  context,
}) => {
  await setup(page, context);
  const bytes = await jpeg();
  const chooser = await confirmNative(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).restorePhotoPut = () => (IDBObjectStore.prototype.put = original);
    IDBObjectStore.prototype.put = function (...args: any[]) {
      if (this.transaction.db.name === 'chunmo-photo-batches')
        throw new DOMException('quota', 'QuotaExceededError');
      return original.apply(this, args as any);
    };
  });
  await chooser.setFiles({ name: 'quota.jpg', mimeType: 'image/jpeg', buffer: bytes });
  await expect(page.locator('.quick-photo')).toContainText('本机暂存失败');
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回管理页面' })).toBeDisabled();
  await page.evaluate(() => (window as any).restorePhotoPut());
  await page.getByRole('button', { name: '重试本机暂存' }).click();
  await expect.poll(async () => (await rows(page)).filter((r) => r.ready).length).toBe(1);
  await expect(page.getByRole('button', { name: '保存本次照片' })).toBeEnabled();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }),
  );
  await page.getByRole('button', { name: '保存本次照片' }).click();
  await expect(page.locator('.quick-photo')).toContainText('不支持此批图片分享');
  expect((await rows(page)).length).toBe(1);
  await page.getByRole('button', { name: '分享不可用，逐张导出' }).click();
  await expect(page.getByAltText('本次照片导出')).toBeVisible();
  expect((await rows(page)).length).toBe(1);
});
