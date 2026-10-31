import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { today, plus } from '../src/lib/model';
async function login(page: Page, account: string, password: string) {
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(account);
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
for (const width of [1440, 1280, 390, 320])
  test(`classified agenda ${width}: mandatory type, correct stores, dates, completion, deletion and retained history`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await login(page, f.login, f.password);
    const data = fixture();
    data.notes = [];
    data.purchases = [];
    expect((await api(page, '/workspace', 'PUT', { revision: 0, data })).status).toBe(200);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.getByTestId('memo-panel')).toHaveCount(0);
    await expect(page.locator('.agenda-brief .brief-panel')).toHaveCount(2);
    await page
      .getByTestId('tomorrow-panel')
      .getByRole('button', { name: '添加明日事项', exact: true })
      .click();
    const category = page.getByRole('dialog', { name: '新增记录', exact: true });
    await expect(category.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await category.getByRole('radio', { name: '采购清单', exact: true }).click();
    let purchase = page.getByRole('dialog', { name: '新建采购事项', exact: true });
    await expect(purchase.getByRole('radio', { name: '采购清单', exact: true })).toBeChecked();
    await expect(purchase.getByRole('radio', { name: '事项管理', exact: true })).not.toBeChecked();
    await purchase.getByLabel('采购内容 / 事项标题', { exact: true }).fill('分类采购电线');
    await purchase.getByLabel('规格型号', { exact: true }).fill('2.5平方');
    await purchase.getByLabel('采购负责人', { exact: true }).fill('采购负责人');
    const tomorrow = await purchase.getByLabel('采购截止日期', { exact: true }).inputValue();
    expect(tomorrow).toBe(plus(today(), 1));
    await purchase.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.purchase-list')).toContainText('分类采购电线');
    await expect(page.locator('.save-state')).toContainText('已保存');
    let saved = (await api(page)).value.data;
    expect(saved.purchases).toHaveLength(1);
    expect(saved.purchases[0]).toMatchObject({
      name: '分类采购电线',
      specification: '2.5平方',
      owner: '采购负责人',
      projectId: data.projects[0].id,
    });
    expect(saved.notes).toEqual([]);
    expect((await api(page, '/records')).value.records).toEqual([]);
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await expect(page.getByTestId('tomorrow-panel')).toContainText('分类采购电线');
    await page
      .getByTestId('today-panel')
      .getByRole('button', { name: '添加今日事项', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: '新增记录', exact: true })
      .getByRole('radio', { name: '事项管理', exact: true })
      .click();
    let record = page.locator('.record-drawer');
    await record.getByLabel('任务事项', { exact: true }).fill('分类事项复核尺寸');
    await record.getByLabel('事项负责人', { exact: true }).fill('现场负责人');
    await record.getByLabel('记录备注', { exact: true }).fill('复核厨房尺寸');
    await record.getByLabel('记录跟进', { exact: true }).fill('等待业主确认');
    await record.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '打开记录：分类事项复核尺寸', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#daily-records,.daily-records')).toHaveCount(0);
    let records = (await api(page, '/records')).value.records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      owner: '现场负责人',
      nodeDate: today(),
      notes: '复核厨房尺寸',
      followUp: '等待业主确认',
    });
    const recordId = records[0].id;
    const purchaseId = saved.purchases[0].id;
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await expect(page.getByTestId('today-panel')).toContainText('分类事项复核尺寸');
    await page
      .getByTestId('today-panel')
      .getByRole('button', { name: '打开事项：分类事项复核尺寸', exact: true })
      .click();
    record = page.locator('.record-drawer');
    await record.getByLabel('记录节点日期', { exact: true }).fill(tomorrow);
    await record.getByRole('button', { name: '保存记录', exact: true }).click();
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await expect(page.getByTestId('today-panel')).not.toContainText('分类事项复核尺寸');
    await expect(page.getByTestId('tomorrow-panel')).toContainText('分类事项复核尺寸');
    await page
      .getByTestId('tomorrow-panel')
      .getByRole('button', { name: '完成分类事项复核尺寸', exact: true })
      .click();
    await expect
      .poll(async () => (await api(page, '/records')).value.records[0].status)
      .toBe('已完成');
    saved = (await api(page)).value.data;
    expect(saved.purchases).toHaveLength(1);
    expect(saved.purchases[0].status).toBe('待采购');
    expect(saved.notes).toEqual([]);
    expect(saved.tasks).toEqual(data.tasks);
    await page.reload();
    await expect(page.getByTestId('tomorrow-panel')).toContainText('已完成');
    await expect(page.getByTestId('tomorrow-panel')).toContainText(data.projects[0].name);
    await expect(page.getByTestId('tomorrow-panel')).toContainText('采购');
    await expect(page.getByTestId('tomorrow-panel')).toContainText('事项');
    await page
      .getByTestId('tomorrow-panel')
      .getByRole('button', { name: '打开采购：分类采购电线', exact: true })
      .click();
    purchase = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
    await purchase.getByLabel('采购截止日期', { exact: true }).fill(today());
    await purchase.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await expect(page.getByTestId('today-panel')).toContainText('分类采购电线');
    await expect(page.getByTestId('tomorrow-panel')).not.toContainText('分类采购电线');
    await mkdir('/tmp/chunmo-agenda-screenshots', { recursive: true });
    await page.screenshot({
      path: `/tmp/chunmo-agenda-screenshots/home-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .getByTestId('tomorrow-panel')
      .getByRole('button', { name: '打开事项：分类事项复核尺寸', exact: true })
      .click();
    record = page.locator('.record-drawer');
    await record.getByRole('tab', { name: '历史', exact: true }).click();
    await expect(record.locator('.record-history')).toContainText('创建');
    await record.getByRole('button', { name: '删除记录', exact: true }).click();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect.poll(async () => (await api(page, '/records')).value.records.length).toBe(0);
    expect((await api(page)).value.data.purchases[0].id).toBe(purchaseId);
    const history = (await api(page, `/records/${recordId}/history`)).value;
    expect(history.record.deleted).toBe(true);
    expect(history.events.some((x: any) => x.operation === 'delete')).toBe(true);
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await page
      .locator('.purchase-list')
      .getByRole('button', { name: /^删除采购/ })
      .click();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect.poll(async () => (await api(page)).value.data.purchases.length).toBe(0);
    expect((await api(page, '/records')).value.records.length).toBe(0);
  });

test('new project templates: seven stages, no generated tasks, independent colors and unchanged existing projects', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await login(page, f.login, f.password);
  const old = fixture();
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data: old })).status).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const ids: string[] = [];
  for (const name of ['七阶段甲工地', '七阶段乙工地']) {
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
    await dialog.getByLabel('项目名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const data = (await api(page)).value.data;
    const p = data.projects.find((x: any) => x.name === name);
    ids.push(p.id);
    const stages = data.trades
      .filter((x: any) => x.projectId === p.id)
      .sort((a: any, b: any) => a.order - b.order);
    expect(stages.map((x: any) => x.name)).toEqual([
      '拆除阶段',
      '砌墙阶段',
      '水电阶段',
      '瓦工阶段',
      '木工阶段',
      '油漆阶段',
      '安装阶段',
    ]);
    expect(new Set(stages.map((x: any) => x.color)).size).toBe(7);
    expect(data.tasks.filter((x: any) => x.projectId === p.id)).toEqual([]);
  }
  const before = (await api(page)).value.data;
  const first = before.trades.filter((x: any) => x.projectId === ids[0]),
    second = before.trades.filter((x: any) => x.projectId === ids[1]);
  expect(first.map((x: any) => x.color)).toEqual(second.map((x: any) => x.color));
  await page.getByRole('button', { name: '编辑拆除阶段', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑工种', exact: true });
  await edit.locator('.trade-colors > summary').click();
  await edit.getByLabel('自定义颜色', { exact: true }).fill('#a25074');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const after = (await api(page)).value.data;
  expect(after.trades.find((x: any) => x.id === second[0].id).color).toBe('#a25074');
  expect(after.trades.filter((x: any) => x.projectId === ids[0])).toEqual(first);
  expect(after.trades.filter((x: any) => x.projectId === old.projects[0].id)).toEqual(
    before.trades.filter((x: any) => x.projectId === old.projects[0].id),
  );
  expect(after.tasks).toEqual(old.tasks);
});

test('classification cannot switch during submission; failed saves preserve fields and retry one unchanged receipt', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await login(page, f.login, f.password);
  const data = fixture();
  data.notes = [];
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data })).status).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const originals = (await api(page)).value.data;
  await page
    .getByTestId('today-panel')
    .getByRole('button', { name: '添加今日事项', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '新增记录', exact: true })
    .getByRole('radio', { name: '事项管理', exact: true })
    .click();
  const drawer = page.locator('.record-drawer');
  await drawer.getByLabel('任务事项', { exact: true }).fill('失败后保留的事项');
  await drawer.getByLabel('事项负责人', { exact: true }).fill('负责人');
  await drawer.getByLabel('记录备注', { exact: true }).fill('不能丢弃的具体内容');
  const bodies: unknown[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) {
        await gate;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '测试临时失败，请重试' }),
        });
      }
    }
    await route.continue();
  });
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(drawer.getByRole('radio', { name: '采购清单', exact: true })).toBeDisabled();
  await expect(drawer.getByRole('radio', { name: '事项管理', exact: true })).toBeChecked();
  release();
  await expect(drawer.getByRole('alert')).toContainText('临时失败');
  await expect(drawer.getByLabel('记录备注', { exact: true })).toHaveValue('不能丢弃的具体内容');
  await expect(drawer.getByRole('radio', { name: '采购清单', exact: true })).toBeEnabled();
  await drawer.getByRole('radio', { name: '采购清单', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '放弃当前未保存的内容？', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(drawer.getByLabel('任务事项', { exact: true })).toHaveValue('失败后保留的事项');
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '打开记录：失败后保留的事项', exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect((await api(page, '/records')).value.records).toHaveLength(1);
  expect((await api(page)).value.data.purchases).toEqual(originals.purchases);
  expect((await api(page)).value.data.notes).toEqual(originals.notes);
});
