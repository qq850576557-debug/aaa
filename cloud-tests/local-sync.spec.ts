import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { today } from '../src/lib/model';

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
  await expect(p.locator('.task-bar').first()).toBeVisible();
  return d;
}
test('online avatar opens a scoped read-only card with identity and live status', async ({
  browser,
}) => {
  const f = await fixtureAccounts();
  const a = await browser.newPage(),
    b = await browser.newPage();
  try {
    await enter(a, f.login, f.password);
    await enter(b, f.employee, f.password);
    await a
      .getByRole('button', { name: `查看${f.employee}的在线名片`, exact: true })
      .click({ timeout: 15000 });
    const card = a.getByRole('dialog', { name: '在线人员名片', exact: true });
    await expect(card).toContainText(f.employee);
    await expect(card).toContainText('在线');
    await expect(card.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});
test('unsubmitted record inputs recover after refresh without creating an incomplete record', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  async function open() {
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await page
      .locator('.board-tool-primary')
      .getByRole('button', { name: '新增记录', exact: true })
      .click();
  }
  await open();
  const drawer = page.locator('.record-drawer');
  await drawer.getByLabel('任务事项', { exact: true }).fill('未提交也不能丢');
  await expect(drawer).toContainText('本地已保存');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await open();
  await expect(drawer.getByLabel('任务事项', { exact: true })).toHaveValue('未提交也不能丢');
  expect((await api(page, '/records')).value.records).toHaveLength(0);
});
test('record outbox survives failure and refresh then reconnects with the exact receipt once', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let offline = true;
  const receipts: string[] = [];
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') {
      receipts.push(route.request().postDataJSON().requestId);
      if (offline) return route.abort('internetdisconnected');
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page
    .locator('.board-tool-primary')
    .getByRole('button', { name: '新增记录', exact: true })
    .click();
  const drawer = page.locator('.record-drawer');
  await drawer.getByLabel('记录所属项目', { exact: true }).selectOption('p-home');
  await drawer.getByLabel('任务事项', { exact: true }).fill('断网自动续传事项');
  await drawer.getByLabel('记录节点日期', { exact: true }).fill(today());
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.locator('.save-feedback')).toContainText('同步失败');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(
      async () =>
        (await api(page, '/records')).value.records.filter(
          (r: any) => r.title === '断网自动续传事项',
        ).length,
      { timeout: 15000 },
    )
    .toBe(1);
  expect(new Set(receipts).size).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const req = indexedDB.open('chunmo-record-outbox');
        return new Promise<number>((resolve) => {
          req.onsuccess = () => {
            const db = req.result;
            const count = db.transaction('pending').objectStore('pending').count();
            count.onsuccess = () => {
              resolve(count.result);
              db.close();
            };
          };
        });
      }),
    )
    .toBe(0);
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page
    .locator('.board-tool-primary')
    .getByRole('button', { name: '新增记录', exact: true })
    .click();
  await expect(page.locator('.record-drawer').getByLabel('任务事项', { exact: true })).toHaveValue(
    '',
  );
});
test('procurement shows all sites in square cards and completed navigation cannot empty the current project list', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  const d = await seed(page);
  d.projects.push({ ...d.projects[0], id: 'site-two', name: '第二工地' });
  d.purchases.push({
    ...d.purchases[0],
    id: 'buy-two',
    projectId: 'site-two',
    taskId: '',
    name: '第二工地采购',
  });
  const s = (await api(page)).value;
  expect((await api(page, '/workspace', 'PUT', { revision: s.revision, data: d })).status).toBe(
    200,
  );
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '已完工项目', exact: true }).click();
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await expect(page.locator('.procurement-workspace .purchase-card')).toHaveCount(2);
  await expect(page.locator('.sidebar-projects')).toContainText('第二工地');
  const box = await page.locator('.procurement-workspace .purchase-card').first().boundingBox();
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
  await page.getByLabel('选择采购工地', { exact: true }).selectOption('site-two');
  await expect(page.locator('.procurement-workspace .purchase-card')).toHaveCount(1);
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await expect(page.locator('.sidebar-projects')).toContainText('第二工地');
});
test('closing a tab releases its journal and a fresh tab resumes the original workspace receipt', async ({
  browser,
}) => {
  const f = await fixtureAccounts();
  const context = await browser.newContext();
  let page = await context.newPage();
  const receipts: string[] = [];
  let blocked = true;
  try {
    await enter(page, f.login, f.password);
    await seed(page);
    await context.route('**/api/workspace', async (route) => {
      if (route.request().method() === 'PUT') {
        receipts.push(route.request().postDataJSON().requestId);
        if (blocked) return route.abort('internetdisconnected');
      }
      await route.continue();
    });
    await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑项目', exact: true });
    await editor.getByLabel('项目名称', { exact: true }).fill('关闭标签页后不能丢');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.error-banner')).toContainText('未丢弃草稿');
    await page.close();
    blocked = false;
    page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.save-state')).toContainText('已保存', { timeout: 15000 });
    expect((await api(page)).value.data.projects[0].name).toBe('关闭标签页后不能丢');
    expect(new Set(receipts).size).toBe(1);
  } finally {
    await context.close();
  }
});
test('a definitive record conflict remains visible after reload and is included in the local backup', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let attempts = 0;
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') {
      attempts++;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: '版本冲突，原内容保留' }),
      });
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page
    .locator('.board-tool-primary')
    .getByRole('button', { name: '新增记录', exact: true })
    .click();
  const drawer = page.locator('.record-drawer');
  await drawer.getByLabel('记录所属项目', { exact: true }).selectOption('p-home');
  await drawer.getByLabel('任务事项', { exact: true }).fill('冲突内容也不能丢');
  await drawer.getByLabel('记录节点日期', { exact: true }).fill(today());
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.locator('.record-board .error-banner')).toContainText('版本冲突');
  await page.reload();
  await expect(page.locator('.save-feedback')).toContainText('同步失败');
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  expect(attempts).toBe(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载未同步内容', exact: true }).click();
  expect((await download).suggestedFilename()).toContain('待同步备份');
});
