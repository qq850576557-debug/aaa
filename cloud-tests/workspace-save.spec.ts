import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { emptyData, newProject, defaultTrades, type Data } from '../src/lib/model';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function enter(page: Page, login: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.sidebar-bottom p')).toContainText('云端工作空间');
  await saved(page);
}
async function saved(page: Page) {
  await expect(page.locator('.save-state')).toContainText('已保存');
}
async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
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
async function seed(page: Page) {
  const d = emptyData();
  d.projects = Array.from({ length: 4 }, (_, i) => ({ ...newProject(), name: `并发工地${i + 1}` }));
  d.trades = d.projects.flatMap((p) => defaultTrades(p.id));
  const s = await api(page);
  expect(
    (await api(page, '/workspace', 'PUT', { revision: s.value.revision, data: d })).status,
  ).toBe(200);
  await page.reload();
  await saved(page);
  return d;
}
async function editor(page: Page, pid?: string) {
  if (pid) await page.locator(`.project-card[data-project-id="${pid}"]`).click();
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  return page.getByRole('dialog', { name: '编辑项目', exact: true });
}
async function closeContexts(contexts: BrowserContext[]) {
  await Promise.all(contexts.map((c) => c.close()));
}
test('four browser sessions save distinct projects concurrently through the real editor without conflicts or lost fields', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts(),
    contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let arrivals = 0;
  try {
    await enter(pages[0], f.login, f.password);
    const d = await seed(pages[0]);
    const logins = [f.login, f.employee];
    for (let i = 2; i < 4; i++) {
      const login = 'browser_' + crypto.randomUUID().replaceAll('-', '');
      expect(
        (await api(pages[0], '/accounts', 'POST', { login, password: f.password })).status,
      ).toBe(201);
      logins.push(login);
    }
    // Login hashing has a deliberate bounded worker pool. Save concurrency starts below,
    // after all four independent sessions have authenticated.
    for (let i = 1; i < pages.length; i++) await enter(pages[i], logins[i], f.password);
    const forms = await Promise.all(pages.map((p, i) => editor(p, d.projects[i].id)));
    for (const c of contexts)
      await c.route('**/api/workspace', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        arrivals++;
        await gate;
        await route.continue();
      });
    await Promise.all(
      forms.map(async (form, i) => {
        await form.getByLabel('项目备注', { exact: true }).fill(`人员${i + 1}已保存`);
        await form.getByRole('button', { name: '保存', exact: true }).click();
      }),
    );
    await expect.poll(() => arrivals).toBe(4);
    release();
    await Promise.all(pages.map(saved));
    const final: Data = (await api(pages[0])).value.data;
    expect(final.projects.map((p) => p.notes)).toEqual([
      '人员1已保存',
      '人员2已保存',
      '人员3已保存',
      '人员4已保存',
    ]);
    for (const p of pages) await expect(p.locator('.error-banner')).toHaveCount(0);
  } finally {
    release();
    await closeContexts(contexts);
  }
});
test('conflicting fields keep the full draft through reload and cloud reread; explicit resolution preserves latest server content', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    await enter(a, f.login, f.password);
    await seed(a);
    await enter(b, f.employee, f.password);
    const af = await editor(a),
      bf = await editor(b);
    await af.getByLabel('项目名称', { exact: true }).fill('云端已提交名称');
    await bf.getByLabel('项目名称', { exact: true }).fill('本地未保存名称');
    await bf.getByLabel('项目备注', { exact: true }).fill('这段备注也必须保留');
    await af.getByRole('button', { name: '保存', exact: true }).click();
    await saved(a);
    await bf.getByRole('button', { name: '保存', exact: true }).click();
    let review = b.getByRole('dialog', { name: '核对保存冲突', exact: true });
    await expect(review).toContainText('本地未保存名称');
    await expect(review).toContainText('云端已提交名称');
    for (const width of [1440, 390]) {
      await b.setViewportSize({ width, height: 900 });
      await expect(review).toBeVisible();
      await expect
        .poll(async () => {
          const rect = await review.boundingBox();
          return rect!.x + rect!.width;
        })
        .toBeLessThanOrEqual(width);
      const rect = await review.boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      expect(await review.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      await b.screenshot({ path: `/tmp/chunmo-concurrency-conflict-${width}.png` });
    }
    await b.setViewportSize({ width: 1440, height: 1000 });
    await review.getByRole('button', { name: '稍后处理', exact: true }).click();
    await expect
      .poll(() =>
        b.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((r, j) => {
            const q = indexedDB.open('chunmo-cloud-drafts', 1);
            q.onsuccess = () => r(q.result);
            q.onerror = () => j(q.error);
          });
          return new Promise<number>((r) => {
            const q = db.transaction('drafts').objectStore('drafts').count();
            q.onsuccess = () => {
              r(q.result);
              db.close();
            };
          });
        }),
      )
      .toBe(1);
    await b.reload();
    await expect(b.locator('.save-state')).toContainText('草稿待恢复');
    await expect(b.locator('.current-project-name')).toHaveText('本地未保存名称');
    await b.getByRole('button', { name: '重新读取云端', exact: true }).click();
    review = b.getByRole('dialog', { name: '核对保存冲突', exact: true });
    await expect(review).toContainText('本地未保存名称');
    await review.getByRole('radio', { name: '采用云端内容' }).check();
    await review.getByRole('button', { name: '确认选择并保存', exact: true }).click();
    await saved(b);
    await expect(review).toHaveCount(0);
    const result = (await api(b)).value;
    expect(result.data.projects[0].name).toBe('云端已提交名称');
    expect(result.data.projects[0].notes).toBe('这段备注也必须保留');
    await b.reload();
    await saved(b);
    await expect(b.locator('.current-project-name')).toHaveText('云端已提交名称');
  } finally {
    await closeContexts(contexts);
  }
});
for (const loseResponse of [false, true])
  test(`edits queued behind a ${loseResponse ? 'lost response' : 'delayed request'} resume safely without reverting another project`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts(),
      contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ids: string[] = [];
    try {
      await enter(a, f.login, f.password);
      const d = await seed(a);
      await enter(b, f.employee, f.password);
      await a.route('**/api/workspace', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        ids.push(route.request().postDataJSON().requestId);
        if (ids.length === 1) {
          await gate;
          if (loseResponse) {
            await route.fetch();
            await route.abort('failed');
            return;
          }
        }
        await route.continue();
      });
      let form = await editor(a);
      await form.getByLabel('项目名称', { exact: true }).fill('第一次本地保存');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => ids.length).toBe(1);
      form = await editor(a);
      await form.getByLabel('项目名称', { exact: true }).fill('第二次排队保存');
      await form.getByLabel('项目备注', { exact: true }).fill('网络未返回期间的新编辑');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      const other = await editor(b, d.projects[1].id);
      await other.getByLabel('项目备注', { exact: true }).fill('乙工地不能回退');
      await other.getByRole('button', { name: '保存', exact: true }).click();
      await saved(b);
      release();
      await saved(a);
      const final = (await api(a)).value.data;
      expect(final.projects[0].name).toBe('第二次排队保存');
      expect(final.projects[0].notes).toBe('网络未返回期间的新编辑');
      expect(final.projects[1].notes).toBe('乙工地不能回退');
      expect(ids).toHaveLength(loseResponse ? 3 : 2);
      expect(new Set(ids).size).toBe(2);
      if (loseResponse) expect(ids[0]).toBe(ids[1]);
    } finally {
      release();
      await closeContexts(contexts);
    }
  });
test('a committed response lost in transit survives refresh and replays the exact receipt once, retaining later server edits', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  const bodies: unknown[] = [];
  try {
    await enter(a, f.login, f.password);
    await seed(a);
    await enter(b, f.employee, f.password);
    let restoring = false,
      restored = false;
    await a.route('**/api/workspace', async (route) => {
      if (route.request().method() !== 'PUT') {
        if (restoring) restored = true;
        return route.continue();
      }
      bodies.push(route.request().postDataJSON());
      if (!restored) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    const form = await editor(a);
    await form.getByLabel('项目备注', { exact: true }).fill('响应丢失但已提交');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(a.locator('.save-state')).toContainText('保存失败');
    const latest = (await api(b)).value;
    latest.data.projects[1].notes = '响应丢失后的他人编辑';
    const change = await api(b, '/workspace', 'PUT', {
      revision: latest.revision,
      data: latest.data,
    });
    expect(change.status).toBe(200);
    const after = change.value.revision;
    const requestId = (bodies[0] as { requestId: string }).requestId;
    await expect
      .poll(() =>
        a.evaluate(async (requestId) => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const r = indexedDB.open('chunmo-cloud-drafts', 1);
            r.onsuccess = () => resolve(r.result);
          });
          const all = await new Promise<any[]>((resolve) => {
            const q = db.transaction('drafts').objectStore('drafts').getAll();
            q.onsuccess = () => resolve(q.result);
          });
          db.close();
          return all.some((x) => x.inFlight?.body?.requestId === requestId);
        }, requestId),
      )
      .toBe(true);
    restoring = true;
    await a.reload();
    await saved(a);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);
    expect(
      (
        await fixtureQuery(
          "SELECT count(*)::int n FROM audit_event WHERE workspace_id=$1 AND actor_id=$2 AND entity_type='workspace_submission' AND entity_id=$3",
          [f.workspaceId, f.id, requestId],
        )
      ).rows[0].n,
    ).toBe(1);
    const final = (await api(a)).value;
    expect(final.revision).toBe(after);
    expect(final.data.projects[0].notes).toBe('响应丢失但已提交');
    expect(final.data.projects[1].notes).toBe('响应丢失后的他人编辑');
  } finally {
    await closeContexts(contexts);
  }
});

test('draft storage failure is explicit and prevents sending until the journal works; retry saves once', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    context = await browser.newContext(),
    p = await context.newPage();
  let requests = 0;
  try {
    await enter(p, f.login, f.password);
    await seed(p);
    await p.route('**/api/workspace', (route) => {
      if (route.request().method() === 'PUT') requests++;
      return route.continue();
    });
    await p.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as any).restoreDraftStorage = () => {
        IDBObjectStore.prototype.put = original;
      };
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
        if (this.name === 'drafts')
          throw new DOMException('No space for draft', 'QuotaExceededError');
        return original.apply(this, args);
      };
    });
    const form = await editor(p);
    await form.getByLabel('项目备注', { exact: true }).fill('存储受限时仍在页面中的草稿');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(p.locator('.error-banner')).toContainText('浏览器无法保留草稿');
    expect(requests).toBe(0);
    expect((await api(p)).value.data.projects[0].notes).toBe('');
    const corrected = await editor(p);
    await corrected.getByLabel('项目备注', { exact: true }).fill('存储恢复前更正后的草稿');
    await corrected.getByRole('button', { name: '保存', exact: true }).click();
    await expect(p.locator('.error-banner')).toContainText('浏览器无法保留草稿');
    expect(requests).toBe(0);
    await p.evaluate(() => (window as any).restoreDraftStorage());
    await p.getByRole('button', { name: '重试保存', exact: true }).click();
    await saved(p);
    expect(requests).toBe(1);
    expect((await api(p)).value.data.projects[0].notes).toBe('存储恢复前更正后的草稿');
  } finally {
    await context.close();
  }
});
test('a duplicated tab receives an independent journal slot instead of overwriting the live tab', async ({
  browser,
}) => {
  const f = await fixtureAccounts(),
    context = await browser.newContext(),
    p = await context.newPage();
  try {
    await enter(p, f.login, f.password);
    await seed(p);
    const original = await p.evaluate(() => sessionStorage.getItem('chunmo-cloud-draft-tab'));
    expect(original).toBeTruthy();
    const clone = await context.newPage();
    await clone.addInitScript((id) => {
      sessionStorage.setItem('chunmo-cloud-draft-tab', id!);
      sessionStorage.setItem('chunmo-space', 'cloud');
    }, original);
    await clone.goto('/');
    await saved(clone);
    const next = await clone.evaluate(() => sessionStorage.getItem('chunmo-cloud-draft-tab'));
    expect(next).not.toBe(original);
    expect(await p.evaluate(() => sessionStorage.getItem('chunmo-cloud-draft-tab'))).toBe(original);
  } finally {
    await context.close();
  }
});
