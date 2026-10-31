import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { peopleTradeFixture } from '../tests/helpers';
import { prepareWorkspace, defaultTrades, type Data } from '../src/lib/model';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function enter(page: Page, login: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(login);
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET'
            ? {}
            : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
test('two authenticated editors concurrently save trade color and personnel order; SSE and re-login preserve both and all original associations', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts(),
    contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  let release = () => {};
  try {
    await enter(a, f.login, f.password);
    const d = prepareWorkspace(peopleTradeFixture());
    d.projects.push({ ...d.projects[0], id: 'shared-color-site', name: '同工序对照工地' });
    d.trades.push(...defaultTrades('shared-color-site'));
    expect((await api(a, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
    await a.reload();
    await expect(a.locator('.save-state')).toContainText('已保存');
    await enter(b, f.employee, f.password);
    await b.getByRole('button', { name: '人员管理', exact: true }).click();
    await a.getByRole('button', { name: '编辑水电改造', exact: true }).click();
    const form = a.getByRole('dialog', { name: '编辑工种', exact: true });
    await form.locator('.trade-colors > summary').click();
    await form.getByLabel('自定义颜色', { exact: true }).fill('#d65d42');
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let waiting = 0;
    for (const c of contexts)
      await c.route('**/api/workspace', async (route) => {
        if (route.request().method() === 'PUT') {
          waiting++;
          await gate;
        }
        await route.continue();
      });
    await Promise.all([
      form.getByRole('button', { name: '保存', exact: true }).click(),
      b.getByRole('button', { name: '下移人员师傅1', exact: true }).click(),
    ]);
    await expect.poll(() => waiting).toBe(2);
    release();
    await Promise.all([a, b].map((p) => expect(p.locator('.save-state')).toContainText('已保存')));
    const saved: Data = (await api(a)).value.data;
    expect(saved.trades[1].color).toBe('#d65d42');
    expect(saved.trades.filter((g) => g.name === '水电改造').map((g) => g.color)).toEqual([
      '#d65d42',
      d.trades.filter((g) => g.name === '水电改造')[1].color,
    ]);
    expect(saved.people!.map((p) => p.id)).toEqual([
      'person-1',
      'person-0',
      ...d.people!.slice(2).map((p) => p.id),
    ]);
    expect(saved.tasks).toEqual(d.tasks);
    expect(saved.trades[1].personnel).toEqual(d.trades[1].personnel);
    expect(saved.trades[1].staffIds).toEqual(d.trades[1].staffIds);
    for (const p of saved.people!) expect(p).toEqual(d.people!.find((x) => x.id === p.id));
    await b.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await expect(b.locator(`[data-trade-id="${d.trades[1].id}"] .task-bar`).first()).toHaveCSS(
      'border-color',
      'rgb(214, 93, 66)',
    );
    await a.getByRole('button', { name: '人员管理', exact: true }).click();
    await expect(a.locator('.people-grid > [data-person-id]').first()).toHaveAttribute(
      'data-person-id',
      'person-1',
    );
    await b.reload();
    await expect(b.locator('.save-state')).toContainText('已保存');
    expect((await api(b)).value.data).toEqual(saved);
    expect(
      (await api(a)).value.history.records.some((r: any) =>
        r.changes.some((c: any) => c.label === '人员显示顺序'),
      ),
    ).toBe(true);
    expect(waiting).toBe(2);
  } finally {
    release();
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('a failed personnel sort is retained as an account draft and recovered on refresh; dictionary rename and deactivation remain shared and traceable', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  const d = prepareWorkspace(peopleTradeFixture());
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '测试：暂时无法保存人员排序' }),
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: '下移人员师傅1', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('暂时无法保存人员排序');
  expect((await api(page)).value.data.people.map((p: any) => p.id)).toEqual(
    d.people!.map((p) => p.id),
  );
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.locator('.error-banner')).toContainText('已恢复本账号的未提交草稿');
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.locator('.people-grid > [data-person-id]').first()).toHaveAttribute(
    'data-person-id',
    'person-1',
  );
  await page.unroute('**/api/workspace');
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const saved = (await api(page)).value;
  expect(saved.data.people[0].id).toBe('person-1');
  expect(saved.data.tasks).toEqual(d.tasks);
  expect(
    saved.history.records.filter((r: any) =>
      r.changes.some((c: any) => c.label === '人员显示顺序'),
    ),
  ).toHaveLength(1);
  await page.getByRole('button', { name: '工种管理', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '人员工种管理', exact: true });
  await manager
    .locator('.dictionary-row')
    .filter({ has: page.getByText('木工', { exact: true }) })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const edit = page.getByRole('dialog', { name: '编辑人员工种', exact: true });
  await edit.getByLabel('人员工种名称').fill('精细木作');
  await edit.getByRole('button', { name: '保存工种', exact: true }).click();
  await manager.getByRole('button', { name: '删除工种精细木作', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await manager.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const final = (await api(page)).value.data as Data;
  expect(final.dictionaries!.find((x) => x.id === 'worker-wood')).toMatchObject({
    label: '精细木作',
    active: false,
  });
  expect(final.people!.find((p) => p.id === 'person-0')!.tradeIds).toEqual(d.people![0].tradeIds);
  expect(final.dictionaries!.find((x) => x.id === 'stage-wood')).toEqual(d.dictionaries![2]);
  expect(final.tasks).toEqual(d.tasks);
  expect(final.trades).toEqual(d.trades);
});
