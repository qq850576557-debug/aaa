import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
const origin = 'http://127.0.0.1:5180';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function login(page: Page, name: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(name);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
async function panel(page: Page) {
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const p = page.getByRole('dialog', { name: '账号管理', exact: true });
  await expect(p.getByRole('tab', { name: '账号与安全', exact: true })).toBeVisible();
  return p;
}
async function api(context: BrowserContext, path: string, method = 'GET', body?: unknown) {
  const session = await (await context.request.get('/api/auth/session')).json();
  return context.request.fetch('/api' + path, {
    method,
    headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
    ...(body === undefined ? {} : { data: body }),
  });
}

test('V1.1 standalone login exposes no business UI or unauthenticated data, and enters cloud directly', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await page.goto('/');
  await expect(page.locator('.brand-login')).toBeVisible();
  await expect(page.locator('.brand-login img')).toBeVisible();
  await expect(page.locator('.project-info,.timeline,.sidebar,.main-shell')).toHaveCount(0);
  for (const path of ['/workspace', '/directory', '/audit'])
    expect((await page.request.get('/api' + path)).status()).toBe(401);
  await login(page, f.login, f.password);
  await expect(page.getByRole('button', { name: '账号管理', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const p = await panel(page);
  await expect(p.getByLabel('登录密码', { exact: true })).toHaveCount(0);
  await expect(p.getByLabel('当前密码', { exact: true })).not.toBeVisible();
});

test('V1.1 Chinese formal names stay separate from author-private notes; owner controls name/status/password only', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts();
  const ownerContext = await browser.newContext(),
    peerContext = await browser.newContext(),
    staffContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage(),
      peer = await peerContext.newPage(),
      staff = await staffContext.newPage();
    await login(owner, f.login, f.password);
    const peerLogin = 'peer_' + randomUUID();
    const created = await api(ownerContext, '/accounts', 'POST', {
      login: peerLogin,
      password: f.password,
      displayName: '油漆小陈',
    });
    expect(created.status()).toBe(201);
    await login(peer, peerLogin, f.password);
    await login(staff, f.employee, f.password);
    let p = await panel(owner);
    await p.getByLabel('我的展示名称', { exact: true }).fill('马春旭');
    await p.getByRole('button', { name: '保存展示名称', exact: true }).click();
    await expect(p.getByRole('heading', { name: '马春旭', exact: true })).toBeVisible();
    await expect(owner.locator('.local-notice')).toContainText('马春旭');
    const identity = await (await api(ownerContext, '/auth/session')).json();
    expect(identity.user.login).toBe(f.login);
    expect(identity.user.id).toBe(f.id);
    await p.getByRole('tab', { name: '账号通讯录', exact: true }).click();
    await p.getByLabel('选择账号').selectOption(f.employeeId);
    await p.getByLabel('员工正式展示名称').fill('木工小李');
    await p.getByRole('button', { name: '保存员工展示名称' }).click();
    await expect(p.locator('.account-selected h3')).toHaveText('木工小李');
    const privateText = '优先电话沟通 · 仅负责人自己可见';
    await p.getByLabel('我的私有备注').fill(privateText);
    await p.getByRole('button', { name: '保存私有备注' }).click();
    await expect(p.getByRole('status')).toContainText('私有备注已保存');
    const peerPanel = await panel(peer);
    await peerPanel.getByRole('tab', { name: '账号通讯录', exact: true }).click();
    await peerPanel.getByLabel('选择账号').selectOption(f.employeeId);
    await expect(peerPanel.getByLabel('我的私有备注')).toHaveValue('');
    await expect(peerPanel.getByLabel('员工正式展示名称')).toHaveCount(0);
    const peerDirectory = await (await api(peerContext, '/directory')).json();
    expect(JSON.stringify(peerDirectory)).not.toContain(privateText);
    await peerPanel.getByLabel('我的私有备注').fill('小陈自己的协作备注');
    await peerPanel.getByRole('button', { name: '保存私有备注' }).click();
    await expect(peerPanel.getByRole('status')).toContainText('私有备注已保存');
    const ownerDirectory = await (await api(ownerContext, '/directory')).json();
    expect(ownerDirectory.accounts.find((a: { id: string }) => a.id === f.employeeId).note).toBe(
      privateText,
    );
    await p.locator('summary').filter({ hasText: '重置员工密码' }).click();
    const reset = p.getByRole('form', { name: '重置员工密码' });
    await reset.getByLabel('新密码', { exact: true }).fill('abcdefgh');
    await reset.getByLabel('确认新密码', { exact: true }).fill('abcdefgh');
    await reset.getByRole('button', { name: '重置员工密码', exact: true }).click();
    await expect(p.getByRole('status')).toContainText('员工密码已重置');
    expect((await staffContext.request.get('/api/auth/session')).status()).toBe(401);
    await staff.reload();
    await login(staff, f.employee, 'abcdefgh');
    const staffIdentity = await (await api(staffContext, '/auth/session')).json();
    expect(staffIdentity.user.id).toBe(f.employeeId);
    expect(staffIdentity.user.owner).toBe(false);
    expect(staffIdentity.user.displayName).toBe('木工小李');
    await p.getByRole('button', { name: '停用员工账号', exact: true }).click();
    await owner.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(p.getByRole('button', { name: '恢复员工账号', exact: true })).toBeVisible();
    expect((await staffContext.request.get('/api/auth/session')).status()).toBe(401);
    await p.getByRole('button', { name: '恢复员工账号', exact: true }).click();
    await owner.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(p.getByRole('button', { name: '停用员工账号', exact: true })).toBeVisible();
  } finally {
    await ownerContext.close();
    await peerContext.close();
    await staffContext.close();
  }
});

test('V1.1 audit filters show server identity and declared mobile device without fabricated iPhone model', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const f = await fixtureAccounts();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  try {
    const page = await context.newPage();
    await login(page, f.login, f.password);
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新建项目', exact: true });
    await form.getByLabel('项目名称', { exact: true }).fill('私密项目标题不进入审计正文');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const p = await panel(page);
    await p.getByRole('tab', { name: '操作记录', exact: true }).click();
    await p.getByLabel('对象类型').selectOption('project');
    await p.getByLabel('操作类型').selectOption('create');
    await p.getByRole('button', { name: '筛选记录' }).click();
    await expect(p.locator('.audit-events')).toContainText('新增项目');
    await expect(p.locator('.audit-events')).toContainText('iPhone（具体型号不可识别）');
    await expect(p.locator('.audit-events')).not.toContainText('私密项目标题不进入审计正文');
    expect((await api(context, '/audit', 'DELETE')).status()).toBeGreaterThanOrEqual(400);
    const bounds = await p.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      viewport: window.innerWidth,
      scroll: element.scrollWidth,
    }));
    expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 2);
  } finally {
    await context.close();
  }
});
