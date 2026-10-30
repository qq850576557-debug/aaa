import { test, expect } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { prepareWorkspace } from '../src/lib/model';

test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
test('startup keeps authentication and draft checks, reads fresh state once, and does not await presence or fetch unused purchase provenance', async ({
  page,
  context,
}) => {
  const f = await fixtureAccounts();
  const origin = 'http://127.0.0.1:5180';
  expect(
    (
      await context.request.post('/api/auth/login', {
        headers: { Origin: origin },
        data: { login: f.login, password: f.password },
      })
    ).status(),
  ).toBe(200);
  const s = await (await context.request.get('/api/auth/session')).json();
  expect(
    (
      await context.request.put('/api/workspace', {
        headers: { Origin: origin, 'X-CSRF-Token': s.csrf },
        data: { revision: 0, data: prepareWorkspace(fixture()) },
      })
    ).status(),
  ).toBe(200);
  let allowSession = () => {},
    allowPresence = () => {};
  const authGate = new Promise<void>((r) => {
    allowSession = r;
  });
  const presenceGate = new Promise<void>((r) => {
    allowPresence = r;
  });
  let workspaceReads = 0,
    provenanceReads = 0,
    sessionReads = 0;
  await page.route('**/api/auth/session', async (route) => {
    sessionReads++;
    await authGate;
    await route.continue();
  });
  await page.route('**/api/presence', async (route) => {
    await presenceGate;
    await route.continue();
  });
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/workspace' && req.method() === 'GET')
      workspaceReads++;
    if (new URL(req.url()).pathname === '/api/purchase-records') provenanceReads++;
  });
  try {
    await page.goto('/');
    await expect.poll(() => sessionReads).toBeGreaterThan(0);
    expect(workspaceReads).toBe(0);
    await expect(page.locator('.project-card')).toHaveCount(0);
    allowSession();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.locator('.task-bar').first()).toBeVisible();
    expect(workspaceReads).toBe(1);
    // Development StrictMode may verify twice; the workspace hook must not add
    // another serial session request. The production benchmark asserts exactly one.
    expect(sessionReads).toBeLessThanOrEqual(2);
    expect(provenanceReads).toBe(0);
    const form = await (async () => {
      await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
      return page.getByRole('dialog', { name: '编辑项目', exact: true });
    })();
    await form.getByLabel('项目备注', { exact: true }).fill('首屏已可操作，在线列表仍在读取');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const fresh = await (await context.request.get('/api/workspace')).json();
    expect(fresh.data.projects[0].notes).toBe('首屏已可操作，在线列表仍在读取');
    expect(provenanceReads).toBe(0);
    allowPresence();
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('项目备注', { exact: true })).toHaveValue(
      '首屏已可操作，在线列表仍在读取',
    );
  } finally {
    allowSession();
    allowPresence();
  }
});

for (const width of [1440, 1280, 390, 320])
  test(`identity capsule ${width}: shared surface, symmetric spacing, no overlap, avatar and name both open the card`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    const origin = 'http://127.0.0.1:5180';
    expect(
      (
        await context.request.post('/api/auth/login', {
          headers: { Origin: origin },
          data: { login: f.login, password: f.password },
        })
      ).status(),
    ).toBe(200);
    const s = await (await context.request.get('/api/auth/session')).json();
    await context.request.patch('/api/auth/profile', {
      headers: { Origin: origin, 'X-CSRF-Token': s.csrf },
      data: { displayName: '林知夏' },
    });
    await page.goto('/');
    await expect(page.locator('.save-state')).toContainText('已保存');
    const group = page.getByRole('group', { name: '当前登录账号' });
    await expect(group).toContainText('林知夏');
    const layout = await group.evaluate((e) => {
      const r = e.getBoundingClientRect(),
        avatar = e.querySelector('.account-avatar')!.getBoundingClientRect(),
        name = e.querySelector('strong')!.getBoundingClientRect();
      return {
        left: avatar.x - r.x,
        right: r.right - name.right,
        gap: name.x - avatar.right,
        centered: Math.abs(avatar.y + avatar.height / 2 - name.y - name.height / 2),
        backgrounds: Array.from(e.querySelectorAll('button')).map(
          (b) => getComputedStyle(b).backgroundColor,
        ),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(8);
    expect(layout.right).toBeGreaterThanOrEqual(12);
    expect(Math.abs(layout.left - layout.right)).toBeLessThan(1);
    expect(layout.gap).toBeGreaterThanOrEqual(8);
    expect(layout.centered).toBeLessThan(2);
    expect(layout.backgrounds).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    expect(layout.overflow).toBe(false);
    for (const name of ['打开我的个人名片', '点击姓名打开我的个人名片']) {
      await page.getByRole('button', { name, exact: true }).click();
      const card = page.getByRole('dialog', { name: '我的个人名片', exact: true });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await expect(card).toHaveCount(0);
    }
  });
