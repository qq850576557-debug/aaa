import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture, editTask } from '../tests/helpers';
async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
test('delete and repeatedly add same-profile workers, keep attendance and choose by internal ID without displaying it', async ({
  page,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts();
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(f.login);
  await page.getByLabel('登录密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const d = fixture();
  const oldId = crypto.randomUUID();
  d.people = [{ id: oldId, name: '叶发华', role: '施工人员', trade: '', notes: '', active: true }];
  d.nameHistory = ['旧文字登记师傅'];
  d.tasks.forEach((t) => {
    t.staffIds = [oldId];
    t.staffAssignment = 'explicit';
  });
  expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  const assessed = await api(page, '/assessments/batch', 'POST', {
    requestId: crypto.randomUUID(),
    confirmed: true,
    edits: [
      {
        date: '2026-11-04',
        personId: oldId,
        projectId: d.projects[0].id,
        tradeId: d.trades[0].id,
        version: 0,
        changes: { attendance: 'yes' },
      },
    ],
  });
  expect(assessed.status).toBe(200);
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.locator('.legacy-people')).toHaveCount(0);
  await page.locator('.person-card').getByRole('button', { name: '删除人员', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(page.locator('.person-card')).toHaveCount(0);
  // Simulate a retained pre-fix editor draft that still carries the deleted ID.
  await page.evaluate(async (old) => {
    const session = await (await fetch('/api/auth/session')).json();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('chunmo-editor-inputs', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('drafts', 'readwrite');
        const key = JSON.stringify([
          session.user.workspaceId,
          session.user.id,
          'editor:person:new',
          sessionStorage.getItem('chunmo-cloud-draft-tab'),
        ]);
        tx.objectStore('drafts').put(
          { value: old, base: old, operationId: crypto.randomUUID() },
          key,
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, d.people[0]);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: '新增人员', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '新增人员档案', exact: true });
    if (i === 0) await expect(modal.getByLabel('姓名', { exact: true })).toHaveValue('叶发华');
    await modal.getByLabel('姓名', { exact: true }).fill('叶发华');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.person-card')).toHaveCount(i + 1);
    await expect(page.locator('.save-state')).toContainText('已保存');
  }
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const saved = (await api(page)).value.data;
  expect(saved.people).toHaveLength(3);
  expect(saved.people.find((p: any) => p.id === oldId).deleted).toBe(true);
  expect(saved.nameHistory).toContain('旧文字登记师傅');
  const attendance = (await api(page, '/assessments?from=2026-11-04&to=2026-11-04')).value.records;
  expect(attendance).toEqual(assessed.value.records);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' }));
  const form = page.getByRole('dialog', { name: '编辑施工任务', exact: true });
  await expect(form.locator('.staff-picker')).not.toContainText('ID：');
  for (const p of saved.people) await expect(form.locator('.staff-picker')).not.toContainText(p.id);
  const replacement = saved.people.find((p: any) => !p.deleted);
  await form.getByLabel('选择施工人员', { exact: true }).selectOption(replacement.id);
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText('已保存');
  const current = (await api(page)).value.data;
  expect(current.tasks.find((t: any) => t.name === '水电定位与布线').staffIds).toEqual([
    replacement.id,
  ]);
  expect((await api(page, '/assessments?from=2026-11-04&to=2026-11-04')).value.records).toEqual(
    attendance,
  );
});
