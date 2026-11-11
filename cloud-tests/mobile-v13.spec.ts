import { test, expect } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { signPlace } from '../server/photo-geocode';

for (const fallback of [false, true, 'empty'])
  test(`V1.3 nearby selection and continuous camera manual=${fallback}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['camera', 'geolocation']);
    await context.setGeolocation({ latitude: 30, longitude: 120, accuracy: 12 });
    const f = await fixtureAccounts();
    await page.goto('/?mobile=1');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    let calls = 0;
    await page.route('**/api/site-photos/location', async (route) => {
      calls++;
      const { location, query, page: number, nearby } = route.request().postDataJSON();
      expect(nearby).toBe(true);
      if (fallback) {
        await route.fulfill(
          fallback === 'empty'
            ? { json: { places: [], more: false } }
            : { status: 503, json: { error: 'provider offline' } },
        );
        return;
      }
      const names = query
        ? ['搜索村庄']
        : number === 2
          ? ['道路测试']
          : ['便利店测试', '住宅测试', '村庄测试'];
      await route.fulfill({
        json: {
          more: !query && number === 1,
          places: names.map((name, index) => ({
            id: name,
            name,
            address: '测试地址',
            distance: 80 + index * 100,
            receipt: signPlace(
              { id: f.id, workspaceId: f.workspaceId, login: f.login, owner: true },
              {
                location,
                placeName: name,
                placeSource: 'amap-poi-selected',
                nearby: true,
                poi: { id: name, latitude: 30, longitude: 120 },
                resolvedAt: new Date().toISOString(),
                expiresAt: new Date(Date.parse(location.obtainedAt) + 90000).toISOString(),
              },
            ),
          })),
        },
      });
    });
    await page.getByRole('button', { name: '拍照', exact: true }).click();
    if (fallback) {
      await expect(page.getByLabel('手动地点名称')).toBeVisible();
      await expect(page.locator('.camera-shutter')).toBeDisabled();
      await page.getByLabel('手动地点名称').fill('自建房现场');
      await page.getByRole('button', { name: '使用此地点' }).click();
      await expect(page.locator('.camera-place')).toHaveText('手动地点：自建房现场');
    } else {
      await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('button', { name: '加载更多' }).click();
      await expect(page.getByRole('option')).toHaveCount(4);
      await page.getByLabel('搜索附近地点').fill('村庄');
      await expect(page.getByRole('option')).toHaveCount(1);
      await page.getByRole('option').click();
      await expect(page.locator('.camera-place')).toHaveText('附近：搜索村庄');
    }
    const before = calls;
    for (let i = 1; i <= 2; i++) {
      await expect(page.locator('.camera-shutter')).toBeEnabled();
      await page.locator('.camera-shutter').click();
      await expect(page.locator('.camera-controls')).toContainText(`本次已拍 ${i} 张`);
    }
    expect(calls).toBe(before);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('chunmo-site-photos');
            r.onsuccess = () => resolve(r.result);
            r.onerror = reject;
          });
          const rows: any[] = await new Promise((resolve, reject) => {
            const r = db.transaction('photos').objectStore('photos').getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = reject;
          });
          db.close();
          return rows.map((r) => ({
            name: r.meta.placeName,
            source: r.meta.placeSource,
            nearby: r.meta.nearby,
          }));
        }),
      )
      .toEqual(
        Array.from({ length: 2 }, () => ({
          name: fallback ? '自建房现场' : '搜索村庄',
          source: fallback ? 'user-manual' : 'amap-poi-selected',
          nearby: !fallback,
        })),
      );
    await page.getByRole('button', { name: '完成拍摄', exact: true }).click();
    await expect(page.locator('.camera-controls')).toHaveCount(0);
  });
