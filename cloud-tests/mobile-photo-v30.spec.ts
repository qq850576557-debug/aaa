import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fixtureAccounts } from '../server/test-fixtures';
import { signPlace } from '../server/photo-geocode';
async function setup(page: Page, context: any, manual = false) {
  await context.grantPermissions(['camera', 'geolocation']);
  await context.setGeolocation({ latitude: 30, longitude: 120, accuracy: 12 });
  const f = await fixtureAccounts();
  await page.goto('/?mobile=1');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.assistant-header')).toBeVisible();
  await page.route('**/api/site-photos/location', async (route) => {
    const { location } = route.request().postDataJSON();
    await route.fulfill({
      json: manual
        ? { places: [], more: false }
        : {
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
    (window as any).cameraCalls = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      (window as any).cameraCalls++;
      return original(c);
    };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: any) => {
        (window as any).shares.push({
          active: navigator.userActivation.isActive,
          files: files.map((f: File) => ({ name: f.name, size: f.size })),
        });
        if ((window as any).cancelShare) throw new DOMException('cancel', 'AbortError');
      },
    });
  });
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '选择拍摄地址' })).toBeVisible();
  return f;
}
async function open(page: Page) {
  await page.getByRole('button', { name: '确认地址并拍摄' }).click();
  await expect(page.locator('.camera-shutter')).toBeEnabled();
}
async function data(page: Page, bytes = false) {
  return page.evaluate(async (want) => {
    const d = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('chunmo-photo-batches');
      r.onsuccess = () => resolve(r.result);
    });
    const rows: any[] = await new Promise((resolve) => {
      const r = d.transaction('photos').objectStore('photos').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    d.close();
    return rows.map((r) => ({
      meta: r.meta,
      ready: !!r.output,
      original: !!r.original,
      error: r.error,
      bytes: want && r.output ? Array.from(new Uint8Array(r.output)) : [],
    }));
  }, bytes);
}
async function still(page: Page, valid = true) {
  const b = valid
    ? await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#bbcbaa' } })
        .jpeg()
        .toBuffer()
    : Buffer.from('broken image');
  await page.evaluate((bytes) => {
    (window as any).ImageCapture = class {
      async takePhoto() {
        return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
      }
    };
  }, Array.from(b));
}
for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
])
  test(`immersive viewport ${viewport.width}: no chooser, full-screen bounds and background hidden`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page, context);
    let chooser = 0;
    page.on('filechooser', () => chooser++);
    await open(page);
    const camera = page.getByRole('dialog', { name: '连续拍摄相机' });
    await expect(camera).toBeVisible();
    await expect(page.locator('.assistant-header')).toBeHidden();
    await expect(page.locator('.assistant-nav')).toBeHidden();
    const box = (await camera.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBe(viewport.width);
    expect(box.height).toBe(viewport.height);
    await expect(camera.locator('video')).toHaveCSS('object-fit', 'cover');
    await expect(camera.locator('.live-watermark')).toContainText('工地定位：测试现场');
    await expect(camera.locator('.live-watermark')).not.toContainText('附近');
    expect(await page.evaluate(() => (window as any).cameraCalls)).toBe(1);
    expect(chooser).toBe(0);
    await page.screenshot({ path: `/tmp/chunmo-v30-camera-${viewport.width}.png` });
    await page.getByRole('button', { name: '关闭相机' }).click();
    await expect(page.locator('.photo-immersive')).toHaveCount(0);
    await expect(page.locator('.assistant-header')).toBeVisible();
  });
test('12MP output preserves full pixels; finish directly invokes active multi-file share and waits for explicit cleanup', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/site-photos$/.test(r.url())) uploads.push(r.url());
  });
  for (let i = 1; i <= 2; i++) {
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.quick-camera-controls')).toContainText(`已拍 ${i} 张`);
    await expect(page.locator('.camera-shutter')).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: '完成拍摄', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).shares.length)).toBe(0);
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.locator('.photo-immersive')).toHaveCount(0);
  const shares = await page.evaluate(() => (window as any).shares);
  expect(shares[0].active).toBe(true);
  expect(shares[0].files.length).toBe(2);
  const rows = await data(page, true);
  expect(rows.every((r) => r.ready && !r.original)).toBe(true);
  const image = await sharp(Buffer.from(rows[0].bytes)).metadata();
  expect([image.width, image.height]).toEqual([4000, 3000]);
  expect(rows[0].meta.captureMethod).toBe('image-capture');
  expect(Buffer.from(rows[0].bytes).toString()).toContain('amap-poi-selected');
  expect(uploads).toEqual([]);
  await page.getByRole('button', { name: '已确认存入相册' }).click();
  expect((await data(page)).length).toBe(0);
});
for (const count of [10, 20])
  test(`continuous ${count}: same stream, silent capture, finish share cancellation and refresh recovery`, async ({
    page,
    context,
  }) => {
    await setup(page, context);
    await page.evaluate(() => {
      (window as any).ImageCapture = undefined;
      (window as any).cancelShare = true;
    });
    await open(page);
    const original = await page.locator('video').evaluate((v: any) => ({
      track: v.srcObject.getVideoTracks()[0].id,
      width: v.videoWidth,
      height: v.videoHeight,
    }));
    const intervals: number[] = [];
    for (let i = 1; i <= count; i++) {
      const t = Date.now();
      await expect(page.locator('.camera-shutter')).toBeEnabled();
      await page.locator('.camera-shutter').click();
      await expect(page.locator('.quick-camera-controls')).toContainText(`已拍 ${i} 张`);
      intervals.push(Date.now() - t);
    }
    expect(await page.evaluate(() => (window as any).cameraCalls)).toBe(1);
    expect(await page.evaluate(() => (window as any).shares.length)).toBe(0);
    expect(
      await page.locator('video').evaluate((v: any) => v.srcObject.getVideoTracks()[0].id),
    ).toBe(original.track);
    await expect(page.getByRole('button', { name: '完成拍摄', exact: true })).toBeEnabled();
    const rows = await data(page);
    expect(rows).toHaveLength(count);
    expect(
      rows.every(
        (r) =>
          r.ready &&
          r.meta.outputWidth === original.width &&
          r.meta.outputHeight === original.height,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
    await expect(page.locator('.quick-photo')).toContainText('未确认保存');
    expect((await data(page)).length).toBe(count);
    const timing = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter((e) => e.name.startsWith('chunmo-photo:'))
        .map((e) => ({ name: e.name, ms: e.duration, detail: (e as PerformanceMeasure).detail })),
    );
    await writeFile(
      `/tmp/chunmo-v30-performance-${count}.json`,
      JSON.stringify(
        {
          environment: 'Linux Chromium fake camera/GPS and share stub; not real iPhone',
          count,
          original,
          intervals,
          timing,
        },
        null,
        2,
      ),
    );
    await page.reload();
    await page.getByRole('button', { name: '拍照', exact: true }).click();
    await expect(page.getByRole('heading', { name: `本次照片 ${count} 张` })).toBeVisible();
    await expect(page.locator('.photo-immersive')).toHaveCount(0);
    expect((await data(page)).every((r) => r.ready)).toBe(true);
  });
test('manual location and rendering failure keep unique original, block unsafe finish and offer recovery', async ({
  page,
  context,
}) => {
  await setup(page, context, true);
  await page.getByLabel('手动地点名称').fill('自建房现场');
  await page.getByRole('button', { name: '使用此地点' }).click();
  await still(page, false);
  await open(page);
  await page.locator('.camera-shutter').click();
  await expect(page.getByRole('button', { name: '有照片处理失败，前往恢复' })).toBeVisible();
  await expect(page.getByRole('button', { name: '完成拍摄', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '有照片处理失败，前往恢复' }).click();
  const row = (await data(page))[0];
  expect(row.original).toBe(true);
  expect(row.meta.placeSource).toBe('user-manual');
  await expect(page.getByRole('button', { name: '保存本次照片' })).toBeDisabled();
});
test('GPS denial never initializes a camera', async ({ page, context }) => {
  await setup(page, context);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_: unknown, fail: Function) => fail({ code: 1 }) },
    }),
  );
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '选择拍摄地址' })).toContainText('定位被拒绝');
  await expect(page.getByRole('button', { name: '确认地址并拍摄' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).cameraCalls)).toBe(0);
});
test('quota failure retains bytes, retries durable save, unsupported share exports without blob navigation', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  await page.evaluate(() => {
    const old = IDBObjectStore.prototype.put;
    (window as any).restore = () => (IDBObjectStore.prototype.put = old);
    IDBObjectStore.prototype.put = function (...args: any[]) {
      if (this.transaction.db.name === 'chunmo-photo-batches')
        throw new DOMException('quota', 'QuotaExceededError');
      return old.apply(this, args as any);
    };
  });
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '照片未可靠暂存，前往恢复' }).click();
  await expect(page.getByRole('button', { name: '返回管理页面' })).toBeDisabled();
  await page.evaluate(() => (window as any).restore());
  await page.getByRole('button', { name: '重试本机暂存' }).click();
  await expect.poll(async () => (await data(page)).filter((r) => r.ready).length).toBe(1);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }),
  );
  await page.getByRole('button', { name: '保存本次照片' }).click();
  await expect(page.locator('.quick-photo')).toContainText('不支持此批图片分享');
  await page.getByRole('button', { name: '分享不可用，逐张导出' }).click();
  await expect(page.getByAltText('本次照片导出')).toBeVisible();
  expect(page.url()).not.toContain('blob:');
  expect((await data(page)).length).toBe(1);
});
test('closing while camera permission is pending discards late stream without reopening', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await page.evaluate(() => {
    const old = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let resolve: () => void;
    (window as any).gate = new Promise<void>((r) => (resolve = r));
    (window as any).release = () => resolve();
    navigator.mediaDevices.getUserMedia = async (c) => {
      await (window as any).gate;
      const stream = await old(c);
      (window as any).late = stream;
      return stream;
    };
  });
  await page.getByRole('button', { name: '确认地址并拍摄' }).click();
  await expect(page.locator('.photo-immersive')).toBeVisible();
  await page.getByRole('button', { name: '关闭相机' }).click();
  await page.evaluate(() => (window as any).release());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).late?.getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
  await expect(page.locator('.photo-immersive')).toHaveCount(0);
});
