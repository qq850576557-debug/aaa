import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fixtureAccounts } from '../server/test-fixtures';
import { signPlace } from '../server/photo-geocode';
import { watermarkLayout } from '../src/lib/photo-layout';
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
    return rows
      .sort((a, b) => a.meta.capturedAt.localeCompare(b.meta.capturedAt))
      .map((r) => ({
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
test('12MP output preserves full pixels; prepared save invokes active multi-file share and waits for confirmation', async ({
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
  await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
  const shares = await page.evaluate(() => (window as any).shares);
  expect(shares[0].active).toBe(true);
  expect(shares[0].files.length).toBe(2);
  const rows = await data(page, true);
  expect(rows.every((r) => r.ready && !r.original)).toBe(true);
  const image = await sharp(Buffer.from(rows[0].bytes)).metadata();
  expect([image.width, image.height]).toEqual([4000, 3000]);
  const layout = watermarkLayout(4000, 3000, rows[0].meta);
  await sharp(Buffer.from(rows[0].bytes))
    .extract({
      left: Math.floor(layout.x),
      top: Math.floor(layout.y),
      width: Math.ceil(layout.boxW),
      height: Math.ceil(layout.boxH),
    })
    .resize({ width: 1100 })
    .toFile('/tmp/chunmo-v31-export-watermark.png');
  expect(rows[0].meta.captureMethod).toBe('image-capture');
  expect(Buffer.from(rows[0].bytes).toString()).toContain('amap-poi-selected');
  expect(uploads).toEqual([]);
  expect((await data(page)).length).toBe(2);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '删除选中照片' }).click();
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
    await page.evaluate(() => {
      (window as any).longTasks = [];
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        const observer = new PerformanceObserver((list) => {
          (window as any).longTasks.push(
            ...list.getEntries().map((e) => ({ at: e.startTime, ms: e.duration })),
          );
        });
        observer.observe({ type: 'longtask' });
      }
    });
    const benchStart = await page.evaluate(() => performance.now());
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
    await expect
      .poll(() =>
        page.evaluate(() => performance.getEntriesByName('chunmo-photo:watermark-durable').length),
      )
      .toBe(count);
    const benchEnd = await page.evaluate(() => performance.now());
    const longTasks = await page.evaluate(
      ({ start, end }) =>
        ((window as any).longTasks || []).filter((e: any) => e.at >= start && e.at <= end),
      { start: benchStart, end: benchEnd },
    );
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
    await expect(page.locator('.photo-review-tile')).toHaveCount(count);
    await page.getByRole('button', { name: '选择第2张照片', exact: true }).click();
    await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toHaveText(
      `保存选中照片（${count - 1}张）`,
    );
    await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
    await expect(page.locator('.quick-photo')).toContainText('已取消');
    expect(await page.evaluate(() => (window as any).shares[0].files.length)).toBe(count - 1);
    await expect(page.getByRole('button', { name: '选择第2张照片', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect((await data(page)).length).toBe(count);
    const timing = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter((e) => e.name.startsWith('chunmo-photo:'))
        .map((e) => ({ name: e.name, ms: e.duration, detail: (e as PerformanceMeasure).detail })),
    );
    await writeFile(
      `/tmp/chunmo-v32-performance-${count}.json`,
      JSON.stringify(
        {
          environment: 'Linux Chromium fake camera/GPS and share stub; not real iPhone',
          count,
          original,
          intervals,
          longTasks,
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
test('rendering failure keeps unique original, blocks unsafe finish and offers recovery', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page, false);
  await open(page);
  await page.locator('.camera-shutter').click();
  await expect(page.getByRole('button', { name: '有照片处理失败，前往恢复' })).toBeVisible();
  await expect(page.getByRole('button', { name: '完成拍摄', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '有照片处理失败，前往恢复' }).click();
  const row = (await data(page))[0];
  expect(row.original).toBe(true);
  expect(row.meta.placeSource).toBe('amap-poi-selected');
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeDisabled();
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
  await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
  await expect(page.locator('.quick-photo')).toContainText('当前浏览器不支持批量保存，请逐张保存');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存第1张照片' }).click();
  const download = await saved;
  expect((await sharp((await download.path())!).metadata()).width).toBe(4000);
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

test('no map results provides retry/search but no manual location or camera bypass', async ({
  page,
  context,
}) => {
  await setup(page, context, true);
  await expect(page.getByRole('dialog', { name: '选择拍摄地址' })).toContainText(
    '暂无可选高德地点',
  );
  await expect(page.getByLabel('手动地点名称')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认地址并拍摄' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).cameraCalls)).toBe(0);
});
test('background GPS renewal outside the selected POI radius disables new capture', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await open(page);
  await page.clock.install({ time: new Date() });
  await context.setGeolocation({ latitude: 30, longitude: 120.1, accuracy: 12 });
  const renewed = page.waitForResponse(
    (r) => r.url().endsWith('/api/site-photos/place') && r.request().method() === 'POST',
  );
  await page.clock.fastForward(46000);
  expect((await renewed).status()).toBe(400);
  await expect(page.locator('.camera-shutter')).toBeDisabled();
  await page.getByRole('button', { name: '关闭相机' }).click();
  await expect(page.locator('.photo-immersive')).toHaveCount(0);
});

for (const code of ['NotAllowedError', 'DataError', 'TypeError', 'AbortError'])
  test(`Android share failure ${code} is explicit and retains every photo`, async ({
    page,
    context,
  }) => {
    await setup(page, context);
    await still(page);
    await open(page);
    await page.locator('.camera-shutter').click();
    await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
    await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled();
    await page.evaluate(
      (name) =>
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async () => {
            (window as any).shareActive = navigator.userActivation.isActive;
            throw new DOMException('test', name);
          },
        }),
      code,
    );
    await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
    await expect(page.locator('.quick-photo')).toContainText(code);
    expect(await page.evaluate(() => (window as any).shareActive)).toBe(true);
    expect((await data(page)).length).toBe(1);
    await expect(page.getByRole('button', { name: '已确认导出，清理副本' })).toHaveCount(0);
    await expect(page.getByLabel('全选照片')).toBeChecked();
  });
test('three-column watermarked thumbnails support select all, multi-select and full-size single download without ZIP', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  for (let i = 1; i <= 4; i++) {
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.quick-camera-controls')).toContainText(`已拍 ${i} 张`);
    await expect(page.locator('.camera-shutter')).toBeEnabled();
  }
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  const save = page.getByRole('button', { name: /^保存选中照片（\d+张）$/ });
  await expect(save).toBeEnabled();
  await expect(page.getByLabel('全选照片')).toBeChecked();
  await expect(page.locator('.photo-review-tile')).toHaveCount(4);
  const columns = await page
    .locator('.photo-review-grid')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(3);
  const thumb = page.getByAltText('第1张水印照片');
  await expect(thumb).toBeVisible();
  expect(
    await thumb.evaluate((img: HTMLImageElement) => Math.max(img.naturalWidth, img.naturalHeight)),
  ).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: '选择第2张照片', exact: true }).click();
  await expect(save).toHaveText('保存选中照片（3张）');
  await save.click();
  expect(await page.evaluate(() => (window as any).shares[0].files.length)).toBe(3);
  await page.getByLabel('全选照片').check();
  await page.getByLabel('全选照片').uncheck();
  await expect(save).toHaveText('保存选中照片（0张）');
  await expect(save).toBeDisabled();
  await page.getByLabel('全选照片').check();
  await expect(save).toBeEnabled();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }),
  );
  await save.click();
  await expect(page.locator('.quick-photo')).toContainText('当前浏览器不支持批量保存，请逐张保存');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存第1张照片', exact: true }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toMatch(/\.jpg$/);
  const image = await sharp((await download.path())!).metadata();
  expect([image.width, image.height]).toEqual([4000, 3000]);
  expect(await readFile((await download.path())!)).toEqual(
    Buffer.from((await data(page, true))[0].bytes),
  );
  expect(page.url()).not.toContain('blob:');
  await expect(page.locator('.quick-photo')).toContainText('Downloads/下载目录');
  expect((await data(page)).length).toBe(4);
  expect(await page.locator('.quick-photo').innerText()).not.toContain('ZIP');
  await page.screenshot({ path: '/tmp/chunmo-v32-gallery-390.png' });
});
test('single-photo share remains usable when browser refuses multiple files', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  for (let i = 1; i <= 2; i++) {
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.quick-camera-controls')).toContainText(`已拍 ${i} 张`);
    await expect(page.locator('.camera-shutter')).toBeEnabled();
  }
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files }: any) => files.length === 1,
    }),
  );
  await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
  await page.getByRole('button', { name: '保存第1张照片', exact: true }).click();
  expect(await page.evaluate(() => (window as any).shares[0].files.length)).toBe(1);
  expect((await data(page)).length).toBe(2);
});
test('finish during watermark processing shows progress and never shares without a new user tap', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const Original = Worker;
    (window as any).Worker = class {
      constructor(url: any, options: any) {
        const w = new Original(url, options),
          post = w.postMessage.bind(w);
        w.postMessage = ((d: any, ...args: any[]) => {
          if (d.file) setTimeout(() => post(d, ...(args as [any])), 1800);
          else post(d, ...(args as [any]));
        }) as any;
        return w;
      }
    };
  });
  await setup(page, context);
  await still(page);
  await open(page);
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.locator('.quick-photo')).toContainText('正在准备照片');
  expect(await page.evaluate(() => (window as any).shares.length)).toBe(0);
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled({
    timeout: 10000,
  });
  await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
  expect(await page.evaluate(() => (window as any).shares[0].active)).toBe(true);
});
test('no Worker/OffscreenCanvas uses a same-pixel stable capture and watermark fallback', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    (window as any).Worker = undefined;
    (window as any).OffscreenCanvas = undefined;
  });
  await setup(page, context);
  await page.evaluate(() => ((window as any).ImageCapture = undefined));
  await open(page);
  const pixels = await page.locator('video').evaluate((v: any) => [v.videoWidth, v.videoHeight]);
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled({
    timeout: 15000,
  });
  const rows = await data(page);
  expect([rows[0].meta.outputWidth, rows[0].meta.outputHeight]).toEqual(pixels);
  expect(rows[0].ready).toBe(true);
});

test('a non-returning Android share reports bounded wait and individual downloads stay usable', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled();
  await page.clock.install();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: () => new Promise(() => {}),
    }),
  );
  await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
  await page.clock.fastForward(13000);
  await expect(page.locator('.quick-photo')).toContainText('系统分享长时间未返回');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存第1张照片' }).click();
  expect((await saved).suggestedFilename()).toMatch(/\.jpg$/);
  expect((await data(page)).length).toBe(1);
});

test('Huawei/vivo-style missing share APIs offer actual single JPEG downloads, no ZIP and no automatic deletion', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  });
  await page.getByRole('button', { name: /^保存选中照片（\d+张）$/ }).click();
  await expect(page.locator('.quick-photo')).toContainText('当前浏览器不支持批量保存，请逐张保存');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存第1张照片' }).click();
  const download = await saved;
  const image = await sharp((await download.path())!).metadata();
  expect([image.width, image.height]).toEqual([4000, 3000]);
  expect((await data(page)).length).toBe(1);
  await expect(page.getByLabel('全选照片')).toBeChecked();
  expect(await page.locator('.quick-photo').innerText()).not.toContain('ZIP');
});

test('iPhone-style unavailable sharing shows a same-page long-press full-resolution image, no Blob navigation', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  await page.getByRole('button', { name: '保存第1张照片' }).click();
  const preview = page.getByRole('dialog', { name: '单张照片保存' });
  await expect(preview).toBeVisible();
  const img = preview.locator('img');
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toMatch(/^data:image\/jpeg;/);
  expect(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual(
    [4000, 3000],
  );
  expect(page.url()).not.toContain('blob:');
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  await expect(page.getByLabel('全选照片')).toBeChecked();
  expect((await data(page)).length).toBe(1);
});

test('continue capture keeps previous files; delete cancel retains selection and explicit deletion removes only selected ID', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled();
  await page.getByRole('button', { name: '继续拍摄', exact: true }).click();
  await expect(page.locator('.camera-shutter')).toBeEnabled();
  await page.locator('.camera-shutter').click();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.locator('.photo-review-tile')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^保存选中照片（2张）$/ })).toBeEnabled();
  const ids = (await data(page)).map((r) => r.meta.requestId);
  await page.getByRole('button', { name: '选择第2张照片', exact: true }).click();
  page.once('dialog', (d) => void d.dismiss());
  await page.getByRole('button', { name: '删除选中照片' }).click();
  expect((await data(page)).map((r) => r.meta.requestId)).toEqual(ids);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '删除选中照片' }).click();
  expect((await data(page)).map((r) => r.meta.requestId)).toEqual([ids[1]]);
  await page.reload();
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('.photo-review-tile')).toHaveCount(1);
  await expect(page.getByAltText('第1张水印照片')).toBeVisible();
});

for (const worker of [true, false])
  test(`legacy ready photo without thumbnail recovers lazily with worker=${worker}, preserving source pixels and metadata`, async ({
    page,
    context,
  }) => {
    await setup(page, context);
    await still(page);
    await open(page);
    await page.locator('.camera-shutter').click();
    await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
    await expect(page.getByRole('button', { name: /^保存选中照片（\d+张）$/ })).toBeEnabled();
    const before = (await data(page, true))[0];
    // Wait for any visible preview cache request before simulating a pre-V3.2 pending record.
    await expect(page.getByAltText('第1张水印照片')).toBeVisible();
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('chunmo-photo-batches');
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite'),
          store = tx.objectStore('photos'),
          r = store.openCursor();
        r.onsuccess = () => {
          const cursor = r.result;
          if (cursor) {
            const row = cursor.value;
            delete row.thumbnail;
            cursor.update(row);
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = reject;
      });
      db.close();
    });
    if (!worker)
      await page.addInitScript(() => {
        (window as any).Worker = undefined;
        (window as any).OffscreenCanvas = undefined;
      });
    await page.reload();
    await page.getByRole('button', { name: '拍照', exact: true }).click();
    const image = page.getByAltText('第1张水印照片');
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((el: HTMLImageElement) => Math.max(el.naturalWidth, el.naturalHeight)),
    ).toBeLessThanOrEqual(240);
    const after = (await data(page, true))[0];
    expect(after.bytes).toEqual(before.bytes);
    expect(after.meta).toEqual(before.meta);
    expect(
      await page.evaluate(() => performance.getEntriesByName('chunmo-photo:watermark').length),
    ).toBe(0);
  });

test('saving an uncached unselected image prepares a preview first and preserves a fresh gesture for single share', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await still(page);
  await open(page);
  for (let i = 1; i <= 2; i++) {
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.quick-camera-controls')).toContainText(`已拍 ${i} 张`);
    await expect(page.locator('.camera-shutter')).toBeEnabled();
  }
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（2张）$/ })).toBeEnabled();
  await page.getByRole('button', { name: '选择第1张照片', exact: true }).click();
  await expect(page.getByRole('button', { name: /^保存选中照片（1张）$/ })).toBeEnabled();
  await page.getByRole('button', { name: '保存第1张照片', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '单张照片保存' });
  await expect(preview).toBeVisible();
  expect(await page.evaluate(() => (window as any).shares.length)).toBe(0);
  await preview.getByRole('button', { name: '保存此照片', exact: true }).click();
  const share = await page.evaluate(() => (window as any).shares[0]);
  expect(share.active).toBe(true);
  expect(share.files.length).toBe(1);
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  await expect(page.getByRole('button', { name: '选择第1张照片', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect((await data(page)).length).toBe(2);
});
