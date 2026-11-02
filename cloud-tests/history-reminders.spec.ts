import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { today } from '../src/lib/model';
import { mkdir } from 'node:fs/promises';
async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
for (const width of [1440, 1280, 390, 320])
  test(`save feedback, cloud history and reminder cards ${width}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await page.goto('/');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.locator('.save-feedback')).toHaveCount(0);
    const d = fixture();
    d.notes = [];
    d.purchases = [
      {
        ...d.purchases[0],
        name: '提醒采购五金',
        due: today(),
        status: '待采购',
        taskId: '',
        leadDays: 0,
      },
    ];
    expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
    const value = {
      projectId: d.projects[0].id,
      title: '提醒现场复核',
      nodeDate: today(),
      status: '待执行',
      notes: '第一版备注',
      followUp: '持续核查',
      owner: '监理',
    };
    const record = await api(page, '/records', 'POST', { requestId: crypto.randomUUID(), value });
    expect(record.status).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    await expect(page.locator('.reminder-center .purchase-list')).toContainText('提醒采购五金');
    await expect(page.locator('.reminder-record-grid')).toContainText('提醒现场复核');
    // Hold the actual save: no success feedback is allowed before the HTTP acknowledgement.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    await page.route('**/api/workspace', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue();
        return;
      }
      calls++;
      await gate;
      await route.continue();
    });
    await page
      .locator('.purchase-list')
      .getByRole('button', { name: /编辑采购/ })
      .click();
    const edit = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
    await edit.getByLabel('采购内容 / 事项标题', { exact: true }).fill('更新后的采购五金');
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(page.locator('.save-feedback')).toContainText('云端同步中');
    await expect(page.locator('.save-feedback')).not.toContainText('云端已保存');
    release();
    await expect(page.locator('.save-feedback')).toContainText('已保存');
    await expect(page.locator('.save-state')).toContainText('已保存');
    const feedback = await page.locator('.save-feedback').boundingBox();
    expect(Math.abs(feedback!.x + feedback!.width / 2 - width / 2)).toBeLessThan(2);
    await expect(page.locator('.save-feedback')).toHaveCount(0, { timeout: 7000 });
    expect(calls).toBe(1);
    await page
      .locator('.reminder-record-grid')
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    const drawer = page.locator('.record-drawer');
    await drawer.getByLabel('记录备注', { exact: true }).fill('第二版备注');
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await page.getByRole('button', { name: '完成提醒现场复核', exact: true }).click();
    await expect(page.locator('.reminder-record-grid')).not.toContainText('提醒现场复核');
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await page.getByRole('button', { name: '历史版本', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '云端历史版本', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('V1');
    await expect(panel).toContainText('修改事项');
    await panel.locator('.cloud-version-open').filter({ hasText: '事项 · V1' }).click();
    await expect(panel.locator('pre')).toContainText('第一版备注');
    await expect(panel).toContainText('历史版本');
    await panel.getByRole('button', { name: '恢复此版本', exact: true }).click();
    await page
      .getByRole('dialog', { name: '恢复此历史版本？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(panel.getByRole('button', { name: '下载恢复前备份', exact: true })).toBeVisible();
    await expect(panel).toContainText('恢复事项');
    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载恢复前备份', exact: true }).click();
    expect((await downloading).suggestedFilename()).toContain('恢复前');
    await mkdir('/tmp/history-ui-screenshots', { recursive: true });
    await page.screenshot({ path: `/tmp/history-ui-screenshots/history-${width}.png` });
    const restored = (await api(page, '/records')).value.records.find(
      (r: any) => r.id === record.value.id,
    );
    expect(restored.notes).toBe('第一版备注');
    expect(restored.status).toBe('待执行');
    expect(restored.version).toBe(4);
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '提醒中心', exact: true }).click();
    await expect(page.locator('.reminder-record-grid')).toContainText('提醒现场复核');
    await page.screenshot({ path: `/tmp/history-ui-screenshots/reminders-populated-${width}.png` });
    await page
      .locator('.reminder-record-grid')
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await page.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(page.locator('.reminder-record-grid')).not.toContainText('提醒现场复核');
    expect(
      (await page.locator('.reminder-center .empty-state').boundingBox())!.height,
    ).toBeLessThan(100);
    await page.screenshot({ path: `/tmp/history-ui-screenshots/reminders-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

test('workspace version preview rejects stale recovery, preserves peer edits and restores only after explicit refresh', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts();
  const login = async (p: Page, name: string) => {
    await p.goto('/');
    await p.getByLabel('登录账号', { exact: true }).fill(name);
    await p.getByLabel('登录密码', { exact: true }).fill(f.password);
    await p.getByRole('button', { name: '登录', exact: true }).click();
    await expect(p.locator('.save-state')).toContainText('已保存');
  };
  await login(page, f.login);
  const d = fixture();
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  let s = await api(page, '/workspace');
  expect(
    (
      await api(page, '/workspace', 'PUT', {
        revision: s.value.revision,
        base: s.value.data,
        baseProof: s.value.baseProof,
        data: {
          ...s.value.data,
          projects: s.value.data.projects.map((p: any, i: number) =>
            i ? p : { ...p, name: '当前项目新版' },
          ),
        },
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '云端历史版本', exact: true });
  const choose = async () => {
    await panel
      .locator('.cloud-version-open')
      .filter({ hasText: '工作空间 · V1' })
      .filter({ hasText: d.projects[0].name })
      .click();
  };
  await choose();
  await expect(panel.locator('.cloud-version-scope')).toContainText(d.projects[0].name);
  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await login(peer, f.employee);
    s = await api(peer, '/workspace');
    expect(
      (
        await api(peer, '/workspace', 'PUT', {
          revision: s.value.revision,
          base: s.value.data,
          baseProof: s.value.baseProof,
          data: {
            ...s.value.data,
            projects: s.value.data.projects.map((p: any, i: number) =>
              i ? p : { ...p, name: '同事最新有效修改' },
            ),
          },
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await panel.getByRole('button', { name: '恢复此版本', exact: true }).click();
    await page
      .getByRole('dialog', { name: '恢复此历史版本？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(panel.getByRole('alert')).toContainText('当前数据已更新');
    expect((await api(page, '/workspace')).value.data.projects[0].name).toBe('同事最新有效修改');
    await panel.getByRole('button', { name: '检查更新', exact: true }).click();
    await choose();
    await page.screenshot({ path: '/tmp/history-ui-screenshots/workspace-detail-1440.png' });
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/history/versions/restore') && r.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: '恢复此版本', exact: true }).click();
    await page
      .getByRole('dialog', { name: '恢复此历史版本？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    const result = await (await response).json();
    await expect(panel).toContainText('下载恢复前备份');
    const backup = await api(page, '/history/restore-backups/' + result.backupId);
    expect(backup.value.state.data.projects[0].name).toBe('同事最新有效修改');
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.locator('.current-project-name')).toHaveText(d.projects[0].name);
    await peer.reload();
    await peer.getByRole('button', { name: '历史版本', exact: true }).click();
    const staff = peer.getByRole('dialog', { name: '云端历史版本', exact: true });
    await staff
      .locator('.cloud-version-open')
      .filter({ hasText: '工作空间 · V1' })
      .filter({ hasText: d.projects[0].name })
      .click();
    await expect(staff.getByRole('button', { name: '恢复此版本', exact: true })).toBeDisabled();
  } finally {
    await context.close();
  }
});

test('undo appears only for its acknowledged workspace operation, never for a later record save', async ({
  page,
}) => {
  const { editTask } = await import('../tests/helpers');
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const d = fixture();
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  await page.reload();
  await page.getByLabel('定位日期', { exact: true }).fill('2026-10-26');
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' }));
  const task = page.getByRole('dialog');
  await task.getByLabel('任务名称', { exact: true }).fill('可撤销的施工调整');
  await task.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    page.locator('.save-feedback').getByRole('button', { name: '撤销', exact: true }),
  ).toBeVisible();
  const record = await api(page, '/records', 'POST', {
    requestId: crypto.randomUUID(),
    value: {
      projectId: d.projects[0].id,
      title: '另一次事项保存',
      nodeDate: today(),
      status: '待执行',
      notes: '',
      followUp: '',
      owner: '',
    },
  });
  expect(record.status).toBe(200);
  await page.getByRole('button', { name: '事项管理', exact: true }).click();
  await page.getByRole('button', { name: '打开记录：另一次事项保存', exact: true }).click();
  const drawer = page.locator('.record-drawer');
  await drawer.getByLabel('记录备注', { exact: true }).fill('当前保存不应撤销旧施工任务');
  await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('.save-feedback')).toContainText('已保存');
  await expect(
    page.locator('.save-feedback').getByRole('button', { name: '撤销', exact: true }),
  ).toHaveCount(0);
  expect(
    (await api(page, '/workspace')).value.data.tasks.some(
      (t: any) => t.name === '可撤销的施工调整',
    ),
  ).toBe(true);
});
