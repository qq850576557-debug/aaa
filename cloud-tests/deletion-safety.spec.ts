import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';

async function api(p: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return p.evaluate(
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
async function enter(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
async function seed(p: Page) {
  const d = fixture();
  expect((await api(p, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  await p.reload();
  await p.getByRole('button', { name: `切换项目${d.projects[0].name}`, exact: true }).click();
  await expect(p.getByRole('button', { name: '编辑当前项目', exact: true })).toBeVisible();
  return d;
}
test('a deleted cloud project cannot reappear in the live sidebar when an old dirty graph recovers', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let allow = false;
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT' && !allow) return route.abort('internetdisconnected');
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await editor.getByLabel('项目备注', { exact: true }).fill('断网中的原始草稿，不得丢失');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.error-banner')).toBeVisible();
  // Independent authenticated API context is not intercepted by the offline browser route.
  const session = await (await page.request.get('/api/auth/session')).json();
  const state = await (await page.request.get('/api/workspace')).json();
  const gone = { ...state.data, projects: [], trades: [], tasks: [], notes: [], purchases: [] };
  expect(
    (
      await page.request.put('/api/workspace', {
        headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': session.csrf },
        data: { revision: state.revision, data: gone },
      })
    ).status(),
  ).toBe(200);
  allow = true;
  await page.reload();
  await expect(page.locator('.error-banner')).toBeVisible();
  await expect(page.locator('.sidebar-project-list .project-card')).toHaveCount(0);
  expect((await api(page)).value.data.projects).toEqual([]);
  await expect(page.getByRole('button', { name: '紧急备份', exact: true })).toBeVisible();
});
test('duplicate new personnel is blocked in the editor, while the original record and unrelated fields stay unchanged', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  const d = await seed(page);
  const s = (await api(page)).value;
  d.people = [
    {
      id: 'original-person',
      name: '同一资料师傅',
      role: '施工人员',
      trade: '',
      notes: '',
      active: true,
    },
  ];
  expect((await api(page, '/workspace', 'PUT', { revision: s.revision, data: d })).status).toBe(
    200,
  );
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.getByRole('button', { name: '新增人员', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增人员档案', exact: true });
  await form.getByLabel('姓名', { exact: true }).fill('同一资料师傅');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '检测到同名同工种的历史人员' })).toBeVisible();
  expect((await api(page)).value.data.people).toEqual(d.people);
  await expect(page.locator('.person-card')).toHaveCount(1);
});

for (const cached of [true, false]) {
  test(`a deleted person's ${cached ? 'previously rejected draft' : 'ambiguous request'} stops recurring after login`, async ({
    page,
  }) => {
    const f = await fixtureAccounts();
    await enter(page, f.login, f.password);
    const data = fixture();
    const person = {
      id: 'removed-worker',
      name: '已删除师傅',
      role: '施工人员' as const,
      trade: '',
      active: true,
      notes: '',
    };
    data.people = [person, { ...person, id: 'coworker', name: '仍在用的师傅' }];
    if (cached) data.trades[0].staffIds = [person.id];
    expect((await api(page, '/workspace', 'PUT', { revision: 0, data })).status).toBe(200);
    const state = (await api(page)).value;
    const removed = structuredClone(state.data) as typeof data;
    removed.people = cached
      ? [{ ...person, deleted: true, active: false }, data.people[1]]
      : [data.people[1]];
    expect(
      (await api(page, '/workspace', 'PUT', { revision: state.revision, data: removed })).status,
    ).toBe(200);
    const source = (await api(page)).value;
    const local = structuredClone(source.data) as typeof data;
    local.people = [
      { ...person, notes: '应留在本机备份的原始资料' },
      local.people![cached ? 1 : 0],
    ];
    local.people[1].notes = '应该继续保存的另一位师傅备注';
    local.trades[1].staffIds = [person.id, 'coworker'];
    const requestId = crypto.randomUUID();
    const draft = await page.evaluate(
      async ({ f, source, local, cached, requestId }) => {
        const tabId = sessionStorage.getItem('chunmo-cloud-draft-tab')!;
        const value = {
          version: 1,
          accountId: f.id,
          workspaceId: f.workspaceId,
          tabId,
          at: new Date().toISOString(),
          base: source,
          mergeBase: source.data,
          data: local,
          inFlight: cached
            ? null
            : {
                view: local,
                body: {
                  revision: source.revision,
                  baseProof: source.baseProof,
                  base: source.data,
                  data: local,
                  requestId,
                },
              },
          ...(cached
            ? {
                holds: [
                  {
                    collection: 'people',
                    id: local.people![0].id,
                    kind: 'validation',
                    reason:
                      '已删除的记录不能通过旧草稿、普通保存或备份导入重新出现；原始内容已保留，请通过历史恢复明确处理。（data.people：该记录已删除，禁止隐式恢复）',
                  },
                ],
              }
            : {}),
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('chunmo-cloud-drafts', 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put(value, JSON.stringify([f.workspaceId, f.id, tabId]));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        return value;
      },
      { f: { id: f.id, workspaceId: f.workspaceId }, source, local, cached, requestId },
    );
    const replay = cached
      ? undefined
      : page.waitForResponse(
          (r) =>
            r.url().endsWith('/api/workspace') &&
            r.request().method() === 'PUT' &&
            r.request().postDataJSON()?.requestId === requestId,
        );
    await page.reload();
    if (replay) {
      const rejection = await replay;
      expect(rejection.status()).toBe(400);
      expect((await rejection.json()).issues).toContainEqual(
        expect.objectContaining({
          resource: { collection: 'people', id: person.id },
        }),
      );
    }
    await expect
      .poll(
        async () =>
          (await api(page)).value.data.people.find((row: { id: string }) => row.id === 'coworker')
            ?.notes,
      )
      .toBe(local.people[1].notes);
    await expect(page.locator('.save-state')).toHaveText('已保存');
    await expect(page.getByText(/已删除的记录不能通过旧草稿/)).toHaveCount(0);

    const after = (await api(page)).value;
    expect(after.data.people.find((row: { id: string }) => row.id === person.id)).toEqual(
      cached ? source.data.people[0] : undefined,
    );
    expect(after.data.trades[0].staffIds).toEqual(source.data.trades[0].staffIds);
    expect(after.data.trades[1].staffIds).toEqual(['coworker']);
    await expect
      .poll(() =>
        page.evaluate(
          async ({ f, tabId }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open('chunmo-cloud-drafts', 1);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            const values = await new Promise<{ active: boolean; copied: number }>(
              (resolve, reject) => {
                const req = db.transaction('drafts').objectStore('drafts').getAllKeys();
                req.onsuccess = () =>
                  resolve({
                    active: req.result.includes(JSON.stringify([f.workspaceId, f.id, tabId])),
                    copied: req.result.filter((key) => JSON.parse(String(key))[0] === 'recovery')
                      .length,
                  });
                req.onerror = () => reject(req.error);
              },
            );
            db.close();
            return values;
          },
          { f: { id: f.id, workspaceId: f.workspaceId }, tabId: draft.tabId },
        ),
      )
      .toEqual({ active: false, copied: 1 });

    expect((await api(page, '/auth/logout', 'POST')).status).toBe(200);
    await enter(page, f.login, f.password);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    const status = page.locator('.sidebar-save-status > button');
    await status.click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载未同步内容' }).click();
    const pack = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
    expect(pack.workspace.entries).toHaveLength(1);
    expect(pack.workspace.entries[0].draft.data).toEqual(draft.data);
    if (cached) expect(pack.workspace.entries[0].draft).toEqual(draft);
    await page.getByRole('button', { name: '人员管理', exact: true }).click();
    await expect(page.locator('.person-card')).toHaveCount(1);
    await expect(page.locator('.person-card')).toContainText('仍在用的师傅');
  });
}
