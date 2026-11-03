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
  await expect(form).toContainText('已有相同姓名和资料');
  expect((await api(page)).value.data.people).toEqual(d.people);
  await expect(page.locator('.person-card')).toHaveCount(1);
});
