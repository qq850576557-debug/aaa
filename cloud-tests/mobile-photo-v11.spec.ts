import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { signPlace } from '../server/photo-geocode';
async function api(p: Page, path: string, method = 'GET', data?: unknown) {
  const s = await (await p.request.get('/api/auth/session')).json();
  return p.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5181', 'X-CSRF-Token': s.csrf },
    ...(data ? { data } : {}),
  });
}
async function enter(p: Page) {
  const f = await fixtureAccounts();
  await p.goto('/?mobile=1');
  await p.getByLabel('登录账号', { exact: true }).fill(f.login);
  await p.getByLabel('登录密码', { exact: true }).fill(f.password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.assistant-header')).toBeVisible();
  await expect(p.locator('.save-state')).toContainText('已保存');
  const d = fixture();
  expect((await api(p, '/workspace', 'PUT', { revision: 0, data: d })).status()).toBe(200);
  await p.reload();
  await expect(p.locator('.assistant-header')).toBeVisible();
  return { f, d };
}
async function mockPlace(p: Page, f: Awaited<ReturnType<typeof fixtureAccounts>>) {
  let calls = 0;
  await p.route('**/api/site-photos/location', async (route) => {
    calls++;
    const { location } = route.request().postDataJSON();
    const now = Date.now();
    await route.fulfill({
      json: signPlace(
        { id: f.id, workspaceId: f.workspaceId, login: f.login, owner: true },
        {
          location,
          placeName: '宝嘉誉府',
          placeSource: 'amap-regeo-aoi-nearby',
          nearby: true,
          resolvedAt: new Date(now).toISOString(),
          expiresAt: new Date(Date.parse(location.obtainedAt) + 90000).toISOString(),
        },
      ),
    });
  });
  return () => calls;
}
async function photos(p: Page) {
  return p.evaluate(async () => {
    const d = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('chunmo-site-photos');
      r.onsuccess = () => resolve(r.result);
      r.onerror = reject;
    });
    const rows: any[] = await new Promise((resolve, reject) => {
      const r = d.transaction('photos').objectStore('photos').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = reject;
    });
    d.close();
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        originalBytes: Array.from(
          new Uint8Array(r.originalBytes || (await r.original.arrayBuffer())),
        ),
        watermarkedBytes: Array.from(
          new Uint8Array(r.watermarkedBytes || (await r.watermarked.arrayBuffer())),
        ),
      })),
    );
  });
}

test('V1.2 name and left header; denied location or missing geocoder never permits a new shot', async ({
  page,
}) => {
  await enter(page);
  expect(await page.title()).toBe('春茉后台管理（手机版）');
  await page.goto('/');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.assistant-header')).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.assistant-brand')).toHaveCSS('justify-content', 'flex-start');
  await page.evaluate(() => {
    (window as any).cameraCalls = 0;
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: (_: unknown, fail: Function) => fail({ code: 1 }) },
      configurable: true,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        (window as any).cameraCalls++;
        throw Error('camera');
      },
      configurable: true,
    });
  });
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('.mobile-photo')).toContainText('定位被拒绝');
  await expect(page.locator('.camera-shutter')).toHaveCount(0);
  await expect(page.locator('.camera-controls')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '从相册选择原图' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '不使用定位' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '拍照所属工地' })).toHaveCount(0);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (ok: Function) =>
          ok({
            coords: { latitude: 30.12345, longitude: 120.12345, accuracy: 12 },
            timestamp: Date.now(),
          }),
      },
      configurable: true,
    }),
  );
  await page.getByRole('button', { name: '重试定位并拍照' }).click();
  await expect(page.locator('.mobile-photo')).toContainText('地点识别尚未配置');
  await expect(page.locator('.camera-shutter')).toHaveCount(0);
});

test('V1.1 continuous live camera: three automatic byte-backed local saves, offline retry, share, optional archive and fresh next session', async ({
  page,
  context,
}) => {
  const { f, d } = await enter(page);
  await context.grantPermissions(['camera', 'geolocation']);
  await context.setGeolocation({ latitude: 30.12345, longitude: 120.12345, accuracy: 12 });
  const calls = await mockPlace(page, f);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator('.assistant-header')).toBeVisible();
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await expect(page.locator('.camera-place')).toHaveText('附近：宝嘉誉府');
  await page.locator('.camera-shutter').click();
  await expect(page.locator('.mobile-photo-row')).toHaveCount(1);
  await expect(page.locator('.camera-shutter')).toBeEnabled();
  await context.setOffline(true);
  for (let n = 2; n <= 3; n++) {
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.mobile-photo-row')).toHaveCount(n);
    await expect(page.locator('.camera-shutter')).toBeEnabled();
  }
  await expect(page.locator('.camera-controls')).toContainText('本次已拍 3 张');
  await expect
    .poll(async () => (await photos(page)).filter((p) => p.watermarkedBytes.length > 100).length)
    .toBe(3);
  const rows = await photos(page);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.original).toBeUndefined();
    expect(row.originalBytes.length).toBeGreaterThan(100);
    expect(row.watermarkedBytes.length).toBeGreaterThan(100);
    expect(row.input.captureSource).toBe('live-camera');
    expect(row.meta.placeName).toBe('宝嘉誉府');
    expect(row.input.projectId).toBe('');
  }
  const m = await sharp(Buffer.from(rows[0].watermarkedBytes)).metadata(),
    o = await sharp(Buffer.from(rows[0].originalBytes)).metadata();
  expect(m.width).toBe(rows[0].input.outputWidth);
  expect(m.height).toBe(rows[0].input.outputHeight);
  expect(m.width).toBeLessThanOrEqual(o.width!);
  await writeFile(
    '/tmp/chunmo-v11-camera-pixels.json',
    JSON.stringify(
      {
        testDevice: 'Chromium fake media device; NOT physical iPhone',
        original: [o.width, o.height],
        watermarked: [m.width, m.height],
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: '/tmp/chunmo-v11-camera.png', fullPage: true });
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
  const row = page.locator('.mobile-photo-row').first();
  await row.getByRole('button', { name: '水印图／存入相册' }).click();
  await expect(page.getByAltText('应用内水印图预览')).toBeVisible();
  expect(await page.getByAltText('应用内水印图预览').getAttribute('src')).toMatch(
    /^data:image\/jpeg/,
  );
  const before = page.url();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: async (data: any) => {
        (window as any).sharedMime = data.files[0].type;
      },
      configurable: true,
    });
  });
  await page.getByRole('button', { name: '存入相册', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('不代表自动写入相册');
  expect(await page.evaluate(() => (window as any).sharedMime)).toBe('image/jpeg');
  expect(page.url()).toBe(before);
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  await context.setOffline(false);
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect
    .poll(async () => (await photos(page)).filter((p) => p.state === 'uploaded').length, {
      timeout: 60000,
    })
    .toBe(3);
  await writeFile(
    '/tmp/chunmo-v12-upload-timings.json',
    JSON.stringify(
      {
        environment: 'Local isolated API and fake camera; NOT real Aliyun upload or mobile network',
        measures: await page.evaluate(() =>
          performance
            .getEntriesByName('chunmo-photo:cloud-upload', 'measure')
            .map((e) => ({ duration: e.duration, detail: (e as PerformanceMeasure).detail })),
        ),
      },
      null,
      2,
    ),
  );
  const first = (await photos(page))[0];
  await page.getByLabel(`照片归档工地${first.input.requestId}`).selectOption(d.projects[0].id);
  await expect
    .poll(
      async () =>
        (await (await api(page, `/site-photos/${first.input.requestId}`)).json()).projectId,
    )
    .toBe(d.projects[0].id);
  await page.screenshot({ path: '/tmp/chunmo-v11-gallery.png', fullPage: true });
  const previousCalls = calls();
  await page.getByRole('button', { name: '拍照', exact: true }).first().click();
  await expect(page.locator('video')).toBeVisible();
  expect(calls()).toBeGreaterThan(previousCalls);
  await expect(page.locator('.camera-controls')).toContainText('本次已拍 0 张');
  await page.clock.install();
  await page.clock.fastForward(91_000);
  await expect(page.locator('.camera-shutter')).toBeDisabled();
  await expect(page.getByRole('button', { name: '定位已过期，重试定位' })).toBeVisible();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
});

test('V1.1 native camera fallback preserves original and uses an internal Safari-safe preview', async ({
  page,
  context,
}) => {
  const { f } = await enter(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 30.12345, longitude: 120.12345, accuracy: 12 });
  await mockPlace(page, f);
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        throw new DOMException('unavailable', 'NotAllowedError');
      },
      configurable: true,
    }),
  );
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开系统相机', exact: true })).toBeVisible();
  await expect(page.getByLabel('系统相机照片')).toHaveAttribute('capture', 'environment');
  const original = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#cbd9c4' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开系统相机', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: '相机原图.jpg', mimeType: 'image/jpeg', buffer: original });
  await expect(page.locator('.mobile-photo-row')).toHaveCount(1);
  await expect.poll(async () => (await photos(page))[0]?.state !== 'captured').toBe(true);
  const row = (await photos(page))[0];
  expect(Buffer.from(row.originalBytes)).toEqual(original);
  expect([row.input.outputWidth, row.input.outputHeight]).toEqual([800, 1200]);
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
  await page
    .locator('.mobile-photo-row')
    .getByRole('button', { name: '原图', exact: true })
    .click();
  await expect(page.getByAltText('应用内原图预览')).toBeVisible();
  expect(page.url()).not.toContain('blob:');
});

test('V1.1 failed watermark retains durable original; local-store failure blocks further shots and supports retry', async ({
  page,
  context,
}) => {
  const { f } = await enter(page);
  await page.evaluate(() =>
    Object.defineProperty(window, 'Worker', { value: undefined, configurable: true }),
  );
  await context.grantPermissions(['camera', 'geolocation']);
  await context.setGeolocation({ latitude: 30.12345, longitude: 120.12345, accuracy: 12 });
  await mockPlace(page, f);
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const proto = HTMLCanvasElement.prototype;
    (window as any).oldToBlob = proto.toBlob;
    proto.toBlob = function (callback, type, quality) {
      if (quality === 0.95) {
        callback(null);
        return;
      }
      (window as any).oldToBlob.call(this, callback, type, quality);
    };
  });
  await page.locator('.camera-shutter').click();
  await expect(page.locator('.mobile-photo-row')).toContainText('原图已保存到应用本地');
  await expect(page.locator('.camera-shutter')).toBeEnabled();
  const raw = (await photos(page))[0];
  expect(raw.state).toBe('captured');
  expect(raw.originalBytes.length).toBeGreaterThan(100);
  expect(raw.watermarkedBytes.length).toBe(0);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = (window as any).oldToBlob;
  });
  await page.getByRole('button', { name: '重试水印', exact: true }).click();
  await expect.poll(async () => (await photos(page))[0].state).not.toBe('captured');
  expect((await photos(page))[0].originalBytes).toEqual(raw.originalBytes);
  await page.evaluate(() => {
    (window as any).oldPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: any[]) {
      if (this.name === 'photos') throw new DOMException('test quota', 'QuotaExceededError');
      return (window as any).oldPut.apply(this, args);
    };
  });
  await page.locator('.camera-shutter').click();
  await expect(page.locator('.mobile-photo')).toContainText('原图尚未写入应用本地');
  await expect(page.locator('.camera-shutter')).toBeDisabled();
  await page.getByRole('button', { name: '春茉后台管理（手机版）首页' }).click();
  await expect(page.locator('.mobile-photo')).toContainText('原图尚未写入本机');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = (window as any).oldPut;
  });
  await page.getByRole('button', { name: '重试本地保存', exact: true }).click();
  await expect(page.locator('.camera-shutter')).toBeEnabled();
  await expect.poll(async () => (await photos(page)).length).toBe(2);
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
});
