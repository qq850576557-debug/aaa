import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fixtureAccounts } from '../server/test-fixtures';
import { signPlace } from '../server/photo-geocode';
import { fixture } from '../tests/helpers';
import { today } from '../src/lib/model';

async function api(page: Page, path: string, method = 'GET', data?: unknown) {
  const session = await (await page.request.get('/api/auth/session')).json();
  const response = await page.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5181', 'X-CSRF-Token': session.csrf },
    ...(data ? { data } : {}),
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function enter(page: Page) {
  const f = await fixtureAccounts();
  await page.goto('/?mobile=1');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.assistant-header')).toBeVisible();
  return f;
}
async function summary(page: Page) {
  return page.evaluate(async () => {
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
    return rows.map((r) => ({
      state: r.state,
      id: r.input.requestId,
      input: r.input,
      originalBytes: Array.from(new Uint8Array(r.originalBytes).subarray(0, 256 * 1024)),
      watermarkedBytes: Array.from(new Uint8Array(r.watermarkedBytes).subarray(0, 256 * 1024)),
    }));
  });
}
async function photoStates(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('chunmo-site-photos');
      r.onsuccess = () => resolve(r.result);
    });
    const rows: any[] = await new Promise((resolve) => {
      const r = db.transaction('photos').objectStore('photos').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return rows.map((r) => r.state);
  });
}
async function placeRoute(
  page: Page,
  f: Awaited<ReturnType<typeof fixtureAccounts>>,
  gate = Promise.resolve(),
) {
  await page.route('**/api/site-photos/location', async (route) => {
    const { location } = route.request().postDataJSON();
    await gate;
    await route.fulfill({
      json: signPlace(
        { id: f.id, workspaceId: f.workspaceId, login: f.login, owner: true },
        {
          location,
          placeName: '验证小区',
          placeSource: 'amap-regeo-aoi-nearby',
          nearby: true,
          resolvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.parse(location.obtainedAt) + 90000).toISOString(),
        },
      ),
    });
  });
}

test('V1.2 camera first frame is independent of geocoding; no shutter before verified place', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['camera', 'geolocation']);
  await context.setGeolocation({ latitude: 30.12345, longitude: 120.12345, accuracy: 12 });
  const f = await enter(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await placeRoute(page, f, gate);
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator('.camera-shutter')).toBeDisabled();
  await expect(page.locator('.mobile-photo-row')).toHaveCount(0);
  release();
  await expect(page.locator('.camera-shutter')).toBeEnabled();
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
});

test('V1.2 worker keeps original 12MP bytes, correct EXIF orientation and full pixel watermark', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 30.12345, longitude: 120.12345, accuracy: 12 });
  const f = await enter(page);
  await placeRoute(page, f);
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        throw Error('native fallback fixture');
      },
      configurable: true,
    }),
  );
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  const original = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: '#cbd9c4' },
  })
    .jpeg({ quality: 98 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开系统相机', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: '12MP原图.jpg', mimeType: 'image/jpeg', buffer: original });
  await expect
    .poll(async () => (await summary(page))[0]?.watermarkedBytes.length || 0)
    .toBeGreaterThan(100);
  const row = (await summary(page))[0];
  expect(Buffer.from(row.originalBytes)).toEqual(original);
  expect([row.input.outputWidth, row.input.outputHeight]).toEqual([3000, 4000]);
  const image = await sharp(Buffer.from(row.watermarkedBytes)).metadata();
  expect([image.width, image.height]).toEqual([3000, 4000]);
  const measures = await page.evaluate(() =>
    performance
      .getEntriesByName('chunmo-photo:watermark', 'measure')
      .map((p) => (p as PerformanceMeasure).detail),
  );
  expect(measures[0].renderer).toBe('worker');
  await writeFile(
    '/tmp/chunmo-v12-12mp.json',
    JSON.stringify({
      source: 'synthetic JPEG, NOT physical iPhone capture',
      original: [4000, 3000],
      exif: 6,
      watermarked: [image.width, image.height],
      originalBytesUnchanged: true,
    }),
  );
});

test('V1.2 camera benchmark: ten photos, retained camera and measured local processing', async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  await context.grantPermissions(['camera', 'geolocation']);
  await context.setGeolocation({ latitude: 30.12345, longitude: 120.12345, accuracy: 12 });
  await page.addInitScript(() => {
    const bag = ((window as any).photoBench = {
      cameraCalls: 0,
      gpsCalls: 0,
      longTasks: [] as number[],
      frames: [] as number[],
      shutterToLocal: [] as number[],
      shotAt: 0,
    });
    document.addEventListener(
      'click',
      (e) => {
        if ((e.target as Element)?.closest('.camera-shutter')) bag.shotAt = performance.now();
      },
      true,
    );
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'photos' && args[0]?.state === 'captured') {
        const start = bag.shotAt;
        this.transaction.addEventListener(
          'complete',
          () => bag.shutterToLocal.push(performance.now() - start),
          { once: true },
        );
      }
      return put.apply(this, args);
    };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => {
      bag.cameraCalls++;
      return gum(...args);
    };
    const gps = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (ok, fail, options) => {
      bag.gpsCalls++;
      setTimeout(() => gps(ok, fail, options), 250);
    };
    try {
      new PerformanceObserver((list) =>
        bag.longTasks.push(...list.getEntries().map((e) => e.duration)),
      ).observe({ type: 'longtask', buffered: true });
    } catch {}
    let last = performance.now();
    const frame = (at: number) => {
      bag.frames.push(at - last);
      last = at;
      if (bag.frames.length < 10000) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const f = await enter(page);
  let placeCalls = 0;
  await page.route('**/api/site-photos/config', (route) =>
    route.fulfill({
      json: {
        enabled: false,
        geocodingEnabled: true,
        actorName: '性能验证员',
        storageStatus: 'disabled',
      },
    }),
  );
  await page.route('**/api/site-photos/location', async (route) => {
    placeCalls++;
    const { location } = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: signPlace(
        { id: f.id, workspaceId: f.workspaceId, login: f.login, owner: true },
        {
          location,
          placeName: '测试小区',
          placeSource: 'amap-regeo-aoi-nearby',
          nearby: true,
          resolvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.parse(location.obtainedAt) + 90000).toISOString(),
        },
      ),
    });
  });
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('.camera-shutter')).toBeEnabled();
  await page.evaluate(() => {
    const b = (window as any).photoBench;
    b.longTasks.length = 0;
    b.frames.length = 0;
  });
  for (let i = 1; i <= 10; i++) {
    await page.locator('.camera-shutter').click();
    await expect(page.locator('.camera-controls')).toContainText(`本次已拍 ${i} 张`);
    await expect(page.locator('.camera-shutter')).toBeEnabled();
  }
  await expect
    .poll(async () => (await photoStates(page)).filter((state) => state === 'pending').length, {
      timeout: 60000,
    })
    .toBe(10);
  // End UI performance sampling before copying image bytes to the test runner.
  const report = await page.evaluate(() => ({
    ...(window as any).photoBench,
    measures: performance
      .getEntriesByType('measure')
      .filter((e) => e.name.startsWith('chunmo-photo:'))
      .map((e) => ({
        name: e.name,
        duration: e.duration,
        detail: (e as PerformanceMeasure).detail,
      })),
  }));
  const rows = await summary(page);
  const original = await sharp(Buffer.from(rows[0].originalBytes)).metadata();
  const marked = await sharp(Buffer.from(rows[0].watermarkedBytes)).metadata();
  expect([marked.width, marked.height]).toEqual([original.width, original.height]);
  expect(report.cameraCalls).toBe(1);
  if (process.env.CHUNMO_PHOTO_BENCHMARK_PHASE !== 'before') {
    expect(report.gpsCalls).toBe(1);
    expect(
      report.measures.filter(
        (m: any) => m.name === 'chunmo-photo:watermark' && m.detail?.renderer === 'worker',
      ),
    ).toHaveLength(10);
  }
  await writeFile(
    `/tmp/chunmo-v12-${process.env.CHUNMO_PHOTO_BENCHMARK_PHASE || 'after'}.json`,
    JSON.stringify(
      {
        environment:
          'Linux Chromium fake camera, granted permissions; simulated GPS callback +250ms and location API +250ms; NOT real iPhone or real AMap latency',
        count: rows.length,
        original: [original.width, original.height],
        watermarked: [marked.width, marked.height],
        placeCalls,
        ...report,
      },
      null,
      2,
    ),
  );
  await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
});

for (const width of [320, 390])
  test(`V1.2 compact save time and fixed typed FAB ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await enter(page);
    const data = fixture();
    data.purchases = Array.from({ length: 8 }, (_, i) => ({
      ...data.purchases[0],
      id: 'p-' + i,
      name: '材料' + i,
      taskId: '',
      due: today(),
    }));
    await api(page, '/workspace', 'PUT', { revision: 0, data });
    for (let i = 0; i < 6; i++)
      await api(page, '/records', 'POST', {
        requestId: crypto.randomUUID(),
        value: {
          projectId: data.projects[0].id,
          title: '事项' + i,
          nodeDate: today(),
          status: '持续跟进',
          notes: '',
          followUp: '',
          owner: '',
        },
      });
    await page.reload();
    const save = page.locator('.mobile-save-status');
    await expect(save.locator('.mobile-save-line')).toHaveText(
      /最新保存：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    );
    expect((await save.locator('button').first().boundingBox())!.height).toBeLessThanOrEqual(28);
    const cloudAt = await save.locator('time').getAttribute('dateTime');
    expect(cloudAt).toBeTruthy();
    const session = await page.evaluate(() => Object.values(sessionStorage));
    expect(session).toContain(cloudAt);
    for (const [tab, label, category] of [
      ['事项', '新增事项', '事项管理'],
      ['采购', '新增采购', '采购清单'],
    ] as const) {
      await page
        .getByRole('navigation', { name: '手机主要入口' })
        .getByRole('button', { name: tab, exact: true })
        .click();
      const fab = page.getByRole('button', { name: label, exact: true });
      const initial = (await fab.boundingBox())!;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const after = (await fab.boundingBox())!;
      expect(after.x).toBe(initial.x);
      expect(after.y).toBe(initial.y);
      expect(after.width).toBe(54);
      const nav = (await page.locator('.assistant-nav').boundingBox())!;
      expect(after.y + after.height).toBeLessThan(nav.y);
      await fab.click();
      const dialog = page.getByRole('dialog');
      await expect(fab).toBeHidden();
      await expect(dialog.getByRole('radio', { name: category, exact: true })).toBeChecked();
      if (tab === '事项') {
        await dialog.getByLabel('记录所属项目', { exact: true }).selectOption(data.projects[0].id);
        await dialog.getByLabel('任务事项', { exact: true }).fill('悬浮新增事项');
        await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
      } else {
        await dialog.getByLabel('所属项目', { exact: true }).selectOption(data.projects[0].id);
        await dialog.getByLabel('采购内容 / 事项标题', { exact: true }).fill('悬浮新增采购');
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
      }
      await expect(dialog).toHaveCount(0);
      await expect(fab).toBeVisible();
      await expect(
        page
          .locator('.mobile-work-row')
          .filter({ hasText: tab === '事项' ? '悬浮新增事项' : '悬浮新增采购' }),
      ).toBeVisible();
      await expect
        .poll(async () =>
          tab === '事项'
            ? (await api(page, '/records')).records.some((r: any) => r.title === '悬浮新增事项')
            : (await api(page, '/workspace')).data.purchases.some(
                (p: any) => p.name === '悬浮新增采购',
              ),
        )
        .toBe(true);
    }
    if (width === 390) {
      let failing = true;
      await page.route('**/api/workspace', async (route) => {
        if (failing && route.request().method() === 'PUT')
          return route.fulfill({ status: 503, json: { error: '模拟保存失败' } });
        return route.continue();
      });
      await page.locator('.mobile-work-row select').first().selectOption('已下单');
      await expect(save).toHaveAttribute('data-save-state', 'failed');
      await expect(save).toContainText('同步失败');
      await expect(save.locator('time')).toHaveCount(0);
      await save.locator(':scope > button').click();
      const confirmed = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/workspace') &&
          response.request().method() === 'PUT' &&
          response.ok(),
      );
      failing = false;
      await save.getByRole('button', { name: '重试同步', exact: true }).click();
      const response = await confirmed;
      await expect(save.locator('time')).toHaveAttribute(
        'dateTime',
        (await response.headerValue('X-Chunmo-Confirmed-At'))!,
      );
      await save.locator(':scope > button').click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/chunmo-v12-mobile-${width}.png`, fullPage: true });
  });
