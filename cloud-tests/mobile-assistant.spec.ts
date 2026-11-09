import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { assessmentToday } from '../src/lib/assessments';
import { plus } from '../src/lib/model';
async function api(p: Page, path: string, method = 'GET', data?: unknown) {
  const s = await (await p.request.get('/api/auth/session')).json();
  return p.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5181', 'X-CSRF-Token': s.csrf },
    ...(data ? { data } : {}),
  });
}
async function enter(p: Page) {
  const f = await fixtureAccounts(2);
  await p.goto('/?mobile=1');
  await p.getByLabel('登录账号', { exact: true }).fill(f.login);
  await p.getByLabel('登录密码', { exact: true }).fill(f.password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.assistant-header')).toBeVisible();
  await expect(p.locator('.save-state')).toContainText('已保存');
  return f;
}
async function seed(p: Page) {
  const d = fixture();
  d.purchases = d.purchases.map((x) => ({
    ...x,
    due: assessmentToday(),
    taskId: '',
    status: '待采购',
  }));
  expect((await api(p, '/workspace', 'PUT', { revision: 0, data: d })).status()).toBe(200);
  for (const [title, date] of [
    ['今日现场核对', assessmentToday()],
    ['明日现场核对', plus(assessmentToday(), 1)],
  ])
    expect(
      (
        await api(p, '/records', 'POST', {
          requestId: crypto.randomUUID(),
          value: {
            projectId: d.projects[0].id,
            title,
            nodeDate: date,
            status: '持续跟进',
            notes: '',
            followUp: '',
            owner: '负责人',
          },
        })
      ).status(),
    ).toBe(200);
  await p.reload();
  await expect(p.locator('.assistant-header')).toBeVisible();
  return d;
}

test('mobile daily reminders and shared record/purchase edits with multiple mentions and required fields', async ({
  page,
}) => {
  const f = await enter(page),
    d = await seed(page);
  await expect(page.locator('#assistant-today')).toContainText('今日现场核对');
  await expect(page.locator('#assistant-tomorrow')).toContainText('明日现场核对');
  await page.screenshot({ path: '/tmp/chunmo-mobile-home-390.png', fullPage: true });
  const timing = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      domContentLoadedMs: Math.round(n.domContentLoadedEventEnd),
      responseMs: Math.round(n.responseEnd),
      transferredHtmlBytes: n.transferSize,
    };
  });
  await writeFile(
    '/tmp/chunmo-mobile-local-performance.json',
    JSON.stringify(
      {
        environment:
          'localhost production preview; Chromium touch emulation; not real phone or cellular network',
        ...timing,
      },
      null,
      2,
    ),
  );

  expect(await page.locator('.sidebar,.timeline-grid,.daily-assessment').count()).toBe(0);
  await page.locator('#assistant-today').getByRole('button', { name: '＋新增' }).click();
  await page.getByRole('radio', { name: '事项管理', exact: true }).check();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务事项', { exact: true }).fill('手机新增事项');
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('记录所属项目').selectOption(d.projects[0].id);
  await dialog.getByLabel('事项负责人').fill('@' + f.employees[0].login);
  await page.locator('.mention-options button').first().click();
  await dialog.getByLabel('事项负责人').fill('@' + f.employees[1].login);
  await page.locator('.mention-options button').first().click();
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      (await (await api(page, '/records')).json()).records.some(
        (r: any) => r.title === '手机新增事项',
      ),
    )
    .toBe(true);
  let rows = await (await api(page, '/records')).json();
  expect(rows.records.find((r: any) => r.title === '手机新增事项').mentionIds).toHaveLength(2);
  await page
    .getByRole('navigation', { name: '手机主要入口' })
    .getByRole('button', { name: '事项', exact: true })
    .click();
  await page.getByLabel('待完成', { exact: true }).check();
  let row = page.locator('.mobile-work-row').filter({ hasText: '手机新增事项' });
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('任务事项', { exact: true }).fill('手机编辑事项');
  await page.getByRole('dialog').getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  row = page.locator('.mobile-work-row').filter({ hasText: '手机编辑事项' });
  await row.getByRole('button', { name: '完成', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel('待完成', { exact: true }).uncheck();
  await expect(page.locator('.mobile-work-row.done')).toContainText('手机编辑事项');
  await page
    .locator('.mobile-work-row.done')
    .filter({ hasText: '手机编辑事项' })
    .getByRole('button', { name: '恢复跟进' })
    .click();
  await expect
    .poll(
      async () =>
        (await (await api(page, '/records')).json()).records.find(
          (r: any) => r.title === '手机编辑事项',
        ).status,
    )
    .toBe('持续跟进');
  await page
    .getByRole('navigation', { name: '手机主要入口' })
    .getByRole('button', { name: '采购', exact: true })
    .click();
  await page.getByLabel('待完成', { exact: true }).check();
  const pr = page.locator('.mobile-work-row').first();
  await pr.locator('select').selectOption('已下单');
  await expect
    .poll(async () => {
      const ws = await (await api(page, '/workspace')).json();
      return ws.data.purchases[0].status;
    })
    .toBe('已下单');
  await page.getByRole('button', { name: '＋新增', exact: true }).click();
  await page.getByRole('radio', { name: '采购清单', exact: true }).check();
  await page.getByLabel('采购内容 / 事项标题', { exact: true }).fill('手机新增材料');
  await page.getByLabel('事项负责人', { exact: true }).fill('@' + f.employees[0].login);
  await page.locator('.mention-options button').first().click();
  await page.getByLabel('事项负责人', { exact: true }).fill('@' + f.employees[1].login);
  await page.locator('.mention-options button').first().click();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await api(page, '/workspace')).json()).data.purchases.find(
          (p: any) => p.name === '手机新增材料',
        )?.mentionIds?.length,
    )
    .toBe(2);

  await page
    .getByRole('navigation', { name: '手机主要入口' })
    .getByRole('button', { name: '事项', exact: true })
    .click();
  await page.getByLabel('待完成', { exact: true }).uncheck();
  row = page.locator('.mobile-work-row').filter({ hasText: '手机编辑事项' });
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /确认|删除/ })
    .last()
    .click();
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.evaluate(() => {
      const h = document.querySelector('.assistant-header')!.getBoundingClientRect();
      const s = document.querySelector('.assistant-content')!.getBoundingClientRect();
      return s.top - h.bottom;
    }),
  ).toBeLessThan(16);
  await page.screenshot({ path: '/tmp/chunmo-mobile-records-390.png', fullPage: true });
});

test('legacy local Blob photos remain readable offline without top-level blob navigation', async ({
  page,
  context,
}) => {
  const f = await enter(page),
    d = await seed(page);
  const original = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#b7c7ae' },
  })
    .jpeg()
    .toBuffer();
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('.mobile-photo')).toBeVisible();
  await context.setOffline(true);
  const id = crypto.randomUUID();
  await page.evaluate(
    async ({ bytes, owner, id, projectId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('chunmo-site-photos', 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('photos')) r.result.createObjectStore('photos');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = reject;
      });
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
        input = {
          requestId: id,
          projectId,
          capturedAt: new Date().toISOString(),
          captureSource: 'file-selection',
          originalName: '旧照片.jpg',
          originalSize: blob.size,
          outputWidth: 1200,
          outputHeight: 800,
          location: null,
        };
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction('photos', 'readwrite');
        t.objectStore('photos').put(
          {
            owner,
            input,
            meta: { ...input, actorId: owner.id, actorName: '旧账号', projectName: '历史工地' },
            original: blob,
            watermarked: blob,
            state: 'pending',
          },
          JSON.stringify([owner.workspaceId, owner.id, id]),
        );
        t.oncomplete = () => resolve();
        t.onerror = reject;
      });
      db.close();
      window.dispatchEvent(new Event('chunmo-photos-local'));
    },
    {
      bytes: Array.from(original),
      owner: { id: f.id, workspaceId: f.workspaceId },
      id,
      projectId: d.projects[0].id,
    },
  );
  await expect(page.locator('.mobile-photo-row')).toHaveCount(1);
  await page
    .locator('.mobile-photo-row')
    .getByRole('button', { name: '原图', exact: true })
    .click();
  await expect(page.getByAltText('应用内原图预览')).toBeVisible();
  expect(await page.getByAltText('应用内原图预览').getAttribute('src')).toMatch(
    /^data:image\/jpeg/,
  );
  expect(page.url()).not.toContain('blob:');
  await page.getByRole('button', { name: '存入相册', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('长按');
});

test('install manifest, static-only service worker cache and desktop retains full navigation', async ({
  page,
}) => {
  await enter(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator('.assistant-header')).toBeVisible();
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBe('春茉后台管理（手机版）');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/?mobile=1');
  expect(manifest.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(
    true,
  );
  const info = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const urls = [];
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      urls.push(...(await c.keys()).map((r) => r.url));
    }
    return { scope: r.scope, urls };
  });
  expect(info.scope).toContain('5181');
  expect(info.urls.some((u) => u.includes('/api/'))).toBe(false);
  const originalWorker = await readFile('dist/sw.js', 'utf8');
  try {
    await writeFile(
      'dist/sw.js',
      originalWorker.replace(
        /chunmo-assistant-shell-[a-f0-9]{16}/g,
        'chunmo-assistant-shell-update-test',
      ),
    );
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      await reg.update();
    });
    await expect(page.getByRole('button', { name: '新版本已就绪，点击更新' })).toBeVisible();
    await expect(page.locator('.assistant-header')).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await Promise.all([
      page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
      page.getByRole('button', { name: '新版本已就绪，点击更新' }).click(),
    ]);
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await caches.keys()).includes('chunmo-assistant-shell-update-test'),
        ),
      )
      .toBe(true);
    await expect(page.locator('.assistant-header')).toBeVisible();
  } finally {
    await writeFile('dist/sw.js', originalWorker);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.assistant-header')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '人员管理', exact: true })).toBeVisible();
});
