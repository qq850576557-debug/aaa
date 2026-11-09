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
  test(`reminder layout ${width}: records first, site-grouped square procurement below, no lost sources`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await enter(page, f.login, f.password);
    const d = await seed(page);
    d.projects.push({ ...d.projects[0], id: 'second-reminder', name: '第二提醒工地' });
    d.purchases.push({
      ...d.purchases[0],
      id: 'second-purchase',
      projectId: 'second-reminder',
      taskId: '',
      name: '第二工地材料',
    });
    const s = (await api(page)).value;
    expect((await api(page, '/workspace', 'PUT', { revision: s.revision, data: d })).status).toBe(
      200,
    );
    for (const p of d.projects)
      expect(
        (
          await api(page, '/records', 'POST', {
            requestId: crypto.randomUUID(),
            value: {
              projectId: p.id,
              title: '现场核对 ' + p.name,
              nodeDate: today(),
              status: '待执行',
              notes: '保留原文',
              followUp: '',
              owner: '',
            },
          })
        ).status,
      ).toBe(200);
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const before = (await api(page)).value;
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    const sections = page.locator('.reminder-center > .reminder-section');
    await expect(sections.nth(0)).toContainText('事项管理');
    await expect(sections.nth(1)).toContainText('采购管理');
    await expect(sections.nth(0)).toContainText('现场核对');
    const a = (await sections.nth(0).boundingBox())!,
      b = (await sections.nth(1).boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    const groups = page.locator('.reminder-purchases .purchase-project-group');
    await expect(groups).toHaveCount(2);
    const first = (await groups.nth(0).boundingBox())!,
      second = (await groups.nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    const card = (await groups.nth(0).locator('.purchase-card').boundingBox())!;
    expect(Math.abs(card.width - card.height)).toBeLessThan(2);
    expect(
      await groups
        .nth(0)
        .locator('.purchase-card')
        .evaluate((node) => getComputedStyle(node).borderLeftWidth),
    ).toBe('1px');
    expect(
      await groups
        .nth(0)
        .locator('.purchase-list')
        .evaluate((node) => getComputedStyle(node).borderLeftWidth),
    ).toBe('0px');
    expect((await api(page)).value).toEqual(before);
    await page.screenshot({ path: `/tmp/reminder-save-${width}.png`, fullPage: true });
    const rendered = (await groups.nth(0).locator('.purchase-card').boundingBox())!;
    expect(Math.abs(rendered.width - rendered.height)).toBeLessThan(2);
  });
test('workspace save sends only the changed signed resource, local feedback is nonblocking and success remains in sidebar', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let body: any;
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT') {
      body = route.request().postDataJSON();
      await gate;
    }
    await route.continue();
  });
  try {
    await expect(page.getByRole('button', { name: '下载数据', exact: true })).toBeVisible();
    await expect(
      page.locator('.topbar').getByRole('button', { name: '本地备份', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑项目', exact: true });
    await editor.getByLabel('项目备注', { exact: true }).fill('增量同步的真实备注');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => body?.protocol).toBe(3);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].collection).toBe('projects');
    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('t-water');
    await expect(page.locator('.sidebar-save-status')).toContainText('正在同步');
    await expect(page.locator('.sidebar-save-status .save-current-state')).toContainText('同步');
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    release();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.locator('.sidebar-save-status')).toContainText('最新保存：');
    await expect(page.locator('.sidebar-save-status')).toBeVisible();
    await expect(page.locator('.save-feedback')).toHaveCount(0);
    expect((await api(page)).value.data.projects[0].notes).toBe('增量同步的真实备注');
  } finally {
    release();
  }
});
test('record editor returns after durable local commit while the server response is held', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let pending = false;
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') {
      pending = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await page
      .locator('.board-tool-primary')
      .getByRole('button', { name: '新增记录', exact: true })
      .click();
    const drawer = page.locator('.record-drawer');
    await drawer.getByLabel('记录所属项目', { exact: true }).selectOption('p-home');
    await drawer.getByLabel('任务事项', { exact: true }).fill('本地先完成的事项');
    await drawer.getByLabel('记录节点日期', { exact: true }).fill(today());
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => pending).toBe(true);
    await expect(page.locator('.sidebar-save-status')).toContainText('正在同步');
    await expect(page.locator('.sidebar-save-status .save-current-state')).toContainText('同步');
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    release();
    await expect
      .poll(
        async () =>
          (await api(page, '/records')).value.records.filter(
            (x: any) => x.title === '本地先完成的事项',
          ).length,
      )
      .toBe(1);
  } finally {
    release();
  }
});
test('same-account re-login resumes an unauthorized pending record with the identical receipt', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  const ids: string[] = [];
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') {
      ids.push(route.request().postDataJSON().requestId);
      if (ids.length === 1)
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: '模拟会话失效' }),
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
  await drawer.getByLabel('任务事项', { exact: true }).fill('重新登录后的续传');
  await drawer.getByLabel('记录节点日期', { exact: true }).fill(today());
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.locator('.sidebar-save-status')).toContainText('同步异常');
  await page.context().clearCookies();
  await enter(page, f.login, f.password);
  await expect
    .poll(
      async () =>
        (await api(page, '/records')).value.records.filter(
          (r: any) => r.title === '重新登录后的续传',
        ).length,
    )
    .toBe(1);
  expect(new Set(ids).size).toBe(1);
});

test('a locally queued record edit cannot race a completion using an obsolete cloud version', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  const created = await api(page, '/records', 'POST', {
    requestId: crypto.randomUUID(),
    value: {
      projectId: 'p-home',
      title: '编辑后立即完成',
      nodeDate: today(),
      status: '待执行',
      notes: '原始内容',
      followUp: '',
      owner: '',
    },
  });
  expect(created.status).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route('**/api/records/*', async (route) => {
    if (route.request().method() === 'PUT' && first) {
      first = false;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await page.getByRole('button', { name: '打开记录：编辑后立即完成', exact: true }).click();
    await page.getByLabel('记录备注', { exact: true }).fill('已经本地保存的新内容');
    await page.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(page.locator('.record-drawer')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '打开记录：编辑后立即完成', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    const complete = page.getByRole('button', { name: '完成编辑后立即完成', exact: true });
    await expect(complete).toBeDisabled();
    release();
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect
      .poll(async () => {
        const r = (await api(page, '/records')).value.records.find(
          (r: any) => r.id === created.value.id,
        );
        return [r.notes, r.status];
      })
      .toEqual(['已经本地保存的新内容', '已完成']);
  } finally {
    release();
  }
});

test('one record acknowledgement cannot announce cloud saved while an unrelated workspace upload remains pending', async ({
  page,
}) => {
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  await seed(page);
  let releaseRecord = () => {},
    releaseWorkspace = () => {};
  const recordGate = new Promise<void>((r) => (releaseRecord = r)),
    workspaceGate = new Promise<void>((r) => (releaseWorkspace = r));
  let sentWorkspace = false;
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') await recordGate;
    await route.continue();
  });
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT') {
      sentWorkspace = true;
      await workspaceGate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await page
      .locator('.board-tool-primary')
      .getByRole('button', { name: '新增记录', exact: true })
      .click();
    await page.getByLabel('记录所属项目', { exact: true }).selectOption('p-home');
    await page.getByLabel('任务事项', { exact: true }).fill('并行上传事项');
    await page.getByLabel('记录节点日期', { exact: true }).fill(today());
    await page.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(page.locator('.record-drawer')).toHaveCount(0);
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
    await page
      .getByRole('dialog', { name: '编辑项目', exact: true })
      .getByLabel('项目备注', { exact: true })
      .fill('另一笔未确认修改');
    await page
      .getByRole('dialog', { name: '编辑项目', exact: true })
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect.poll(() => sentWorkspace).toBe(true);
    releaseRecord();
    await expect.poll(async () => (await api(page, '/records')).value.records.length).toBe(1);
    await expect(page.locator('.sidebar-save-status .save-current-state')).toContainText('同步');
    await expect(page.locator('.sidebar-save-status')).toContainText('正在同步');
    releaseWorkspace();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.locator('.sidebar-save-status')).toContainText('最新保存：');
  } finally {
    releaseRecord();
    releaseWorkspace();
  }
});

test('compact reminder preview: left content, bottom site, vertical actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const f = await fixtureAccounts();
  await enter(page, f.login, f.password);
  const d = await seed(page);
  for (const title of [
    '二楼房间木地板铺设',
    '全屋定制安装进度',
    '墙面油漆修复',
    '油漆墙面修补',
    '儿童房水暖',
    '木工之前安装吊顶单杠',
  ]) {
    expect(
      (
        await api(page, '/records', 'POST', {
          requestId: crypto.randomUUID(),
          value: {
            projectId: d.projects[0].id,
            title,
            nodeDate: today(),
            status: '持续跟进',
            notes: '',
            followUp: '',
            owner: '',
          },
        })
      ).status,
    ).toBe(200);
  }
  await page.getByRole('button', { name: '提醒中心', exact: true }).click();
  const cards = page.locator('.reminder-record-grid .agenda-item');
  await expect(cards).toHaveCount(6);
  const card = cards.first();
  const buttons = card.locator('.agenda-item-actions > button');
  const bounds = await Promise.all([0, 1, 2].map((i) => buttons.nth(i).boundingBox()));
  expect(bounds[0]!.x).toBe(bounds[1]!.x);
  expect(bounds[1]!.x).toBe(bounds[2]!.x);
  expect(bounds[0]!.y).toBeLessThan(bounds[1]!.y);
  expect(bounds[1]!.y).toBeLessThan(bounds[2]!.y);
  expect((await card.boundingBox())!.width).toBeLessThan(360);
  await page.screenshot({ path: '/tmp/reminder-compact-preview.png', fullPage: true });
});
