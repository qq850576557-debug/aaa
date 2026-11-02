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
for (const width of [1280, 1440])
  test(`desktop ${width}: bounded home cards, purchase controls and completed-last without rewriting fields`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await enter(page, f.login, f.password);
    const d = await seed(page);
    for (const [title, status] of [
      ['很长的事项名称'.repeat(12), '待执行'],
      ['先完成的事项', '已完成'],
    ] as const) {
      expect(
        (
          await api(page, '/records', 'POST', {
            requestId: crypto.randomUUID(),
            value: {
              projectId: d.projects[0].id,
              title,
              nodeDate: today(),
              status,
              notes: '完整备注保留',
              followUp: '',
              owner: '历史负责人',
            },
          })
        ).status,
      ).toBe(200);
    }
    const state = (await api(page)).value;
    const updated = structuredClone(state.data);
    updated.purchases = [
      { ...updated.purchases[0], id: 'completed-first', name: '先完成采购', status: '已完成' },
      { ...updated.purchases[0], id: 'open-last', name: '后来未完采购', status: '待采购' },
    ];
    expect(
      (await api(page, '/workspace', 'PUT', { revision: state.revision, data: updated })).status,
    ).toBe(200);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const home = page
      .locator('[data-testid="today-panel"] .agenda-item')
      .filter({ hasText: '很长的事项名称' })
      .first();
    await expect(home).toBeVisible();
    const content = page.locator('[data-testid="today-panel"] .brief-content');
    for (const tile of await content.locator('.agenda-item').all()) {
      const rect = (await tile.boundingBox())!;
      expect(Math.abs(rect.width - rect.height)).toBeLessThan(2);
      expect(rect.height).toBeLessThanOrEqual(130);
    }
    const bounds = (await content.boundingBox())!;
    const footer = (await page
      .locator('[data-testid="today-panel"] .brief-actions')
      .boundingBox())!;
    expect(footer.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
    const box = (await home.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(130);
    expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    await page.screenshot({ path: `/tmp/density-home-${width}.png` });
    await home.locator('.agenda-item-main').click();
    await expect(
      page.locator('.record-drawer').getByLabel('任务事项', { exact: true }),
    ).toHaveValue('很长的事项名称'.repeat(12));
    await page.locator('.record-drawer').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    const cards = page.locator('.procurement-workspace .purchase-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('后来未完采购');
    await expect(cards.last()).toHaveClass(/done/);
    const card = cards.first(),
      controls = card.locator('.purchase-actions');
    await expect(controls.locator(':scope > *')).toHaveCount(3);
    const positions = await controls
      .locator(':scope > *')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ tag: n.tagName, rect: n.getBoundingClientRect().toJSON() })),
      );
    expect(positions.map((x) => x.tag)).toEqual(['SELECT', 'BUTTON', 'BUTTON']);
    expect(
      Math.max(...positions.map((x) => x.rect.y)) - Math.min(...positions.map((x) => x.rect.y)),
    ).toBeLessThan(2);
    const donePositions = await cards
      .last()
      .locator('.purchase-actions > *')
      .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().y));
    expect(Math.max(...donePositions) - Math.min(...donePositions)).toBeLessThan(2);
    const cb = (await card.boundingBox())!;
    expect(cb.width).toBeLessThanOrEqual(181);
    expect(Math.abs(cb.width - cb.height)).toBeLessThan(2);
    await expect(card.locator('.purchase-complete')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/density-purchase-${width}.png` });
    const before = (await api(page)).value;
    await card.getByRole('combobox').selectOption('已完成');
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(cards.last()).toContainText('后来未完采购');
    await expect(cards.last()).toHaveClass(/done/);
    const after = (await api(page)).value;
    expect(after.data.purchases.find((x: any) => x.id === 'open-last')).toEqual({
      ...before.data.purchases.find((x: any) => x.id === 'open-last'),
      status: '已完成',
    });
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await expect(page.locator('.record-card').first()).toContainText('很长的事项名称');
    await expect(page.locator('.record-card').last()).toHaveClass(/done/);
    await page.screenshot({ path: `/tmp/page-density-${width}.png`, fullPage: true });
  });
