import { test, expect, type Page } from '@playwright/test';
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
  await expect(p.locator('.task-bar').first()).toBeVisible();
  return d;
}
test('fresh open is quiet; normal draft replay is neutral, errors remain visible and confirmed success fades after three seconds', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  await page.addInitScript(() => {
    (window as any).warningTexts = [];
    new MutationObserver(() =>
      document.querySelectorAll('.error-banner').forEach((n) => {
        (window as any).warningTexts.push(n.textContent);
      }),
    ).observe(document, { subtree: true, childList: true });
  });
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).warningTexts)).toEqual([]);
  let phase = 'offline';
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT') {
      if (phase === 'offline') return route.abort('internetdisconnected');
      if (phase === 'hold') await gate;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await editor.getByLabel('项目备注', { exact: true }).fill('断网保留并恢复，其他字段不变');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.error-banner')).toBeVisible();
  await expect(page.locator('.save-feedback')).toContainText('同步失败');
  phase = 'hold';
  await page.reload();
  try {
    await expect(page.locator('.save-feedback')).toContainText('同步中');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).warningTexts)).toEqual([]);
    phase = 'pass';
    release();
    await expect(page.locator('.save-feedback')).toContainText('云端已保存');
    await expect(page.locator('.save-feedback')).toHaveCount(0, { timeout: 4500 });
    expect((await api(page)).value.data.projects[0].notes).toBe('断网保留并恢复，其他字段不变');
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally {
    release();
  }
});
