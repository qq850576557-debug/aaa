import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { boot, closeToast, editTask, fixture, restore, state } from './helpers';
import type { History } from '../src/lib/history';
async function versions(page: Page): Promise<History> {
  return page.evaluate(
    async () =>
      await new Promise((resolve, reject) => {
        const r = indexedDB.open('chunmo-workspace', 1);
        r.onsuccess = () => {
          const db = r.result,
            q = db.transaction('workspace').objectStore('workspace').get('history');
          q.onsuccess = () => {
            resolve(q.result);
            db.close();
          };
          q.onerror = () => reject(q.error);
        };
        r.onerror = () => reject(r.error);
      }),
  );
}
async function openHistory(page: Page) {
  await closeToast(page);
  await page.getByRole('button', { name: '版本历史 · 15天', exact: true }).click();
  return page.getByRole('dialog', { name: '最近15天修改历史', exact: true });
}
async function changeName(page: Page, name: string) {
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const f = page.getByRole('dialog');
  await f.getByLabel('项目名称', { exact: true }).fill(name);
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects[0].name).toBe(name);
  await expect(page.locator('.save-state')).toContainText('已保存');
}
test.use({ timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
});

test('history: successful timestamp, readable diffs, arbitrary multi-change restore, repeated restore and project isolation persist', async ({
  page,
}) => {
  const d = fixture();
  d.projects.push({ ...d.projects[0], id: 'other', name: '另一个项目', notes: '不要覆盖' });
  await boot(page);
  await restore(page, d);
  expect((await state(page)).projects[0].updatedAt).toBe('2026-10-23T04:00:00.000Z');
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:04Z'));
  await changeName(page, '修改后的项目');
  expect((await state(page)).projects[0].updatedAt).toBe('2026-10-23T04:00:04.000Z');
  const changed = (await versions(page)).records.find(
    (r) =>
      r.scope === 'p-home' &&
      r.changes.some((c) => c.label.endsWith('名称') && c.after === '修改后的项目'),
  )!;
  await page.getByRole('button', { name: '采购管理', exact: true }).click();
  await page.getByRole('button', { name: '编辑采购电线及线管', exact: true }).first().click();
  let f = page.getByRole('dialog');
  await f.getByLabel('采购截止日期', { exact: true }).fill('2026-10-22');
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).purchases[0].due).toBe('2026-10-22');
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await page
    .getByTestId('task-bar')
    .filter({ hasText: '水电定位与布线' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除时间条', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(2);
  let history = await openHistory(page);
  expect(await history.evaluate((e) => e.matches(':modal'))).toBe(false);
  let card = history.locator(`[data-revision-id="${changed.id}"]`);
  await card.getByRole('button', { name: '查看修改详情', exact: true }).click();
  await expect(card.locator('del').filter({ hasText: d.projects[0].name })).toContainText(
    d.projects[0].name,
  );
  await expect(card.locator('ins').filter({ hasText: '修改后的项目' })).toContainText(
    '修改后的项目',
  );
  const beforeRestore = await state(page),
    oldRecords = (await versions(page)).records.map((r) => r.id);
  await card.getByRole('button', { name: '恢复到修改前', exact: true }).click();
  let confirmation = page.getByRole('dialog', { name: '恢复到此次修改之前？', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect((await state(page)).tasks).toHaveLength(2);
  await card.getByRole('button', { name: '恢复到修改前', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(3);
  let actual = await state(page);
  expect(actual.projects[0].name).toBe(d.projects[0].name);
  expect(actual.purchases[0].taskId).toBe('t-water');
  expect(actual.purchases[0].due).toBe('2026-10-23');
  expect(actual.projects[1]).toEqual(beforeRestore.projects[1]);
  const after = await versions(page);
  expect(after.records.map((r) => r.id)).toEqual(expect.arrayContaining(oldRecords));
  const restored = after.records.at(-1)!;
  expect(restored.action).toBe('恢复');
  expect(restored.source).toBe(changed.id);
  card = history.locator(`[data-revision-id="${restored.id}"]`);
  await card.getByRole('button', { name: '恢复到修改前', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks.length).toBe(2);
  actual = await state(page);
  expect(actual.projects[0].name).toBe('修改后的项目');
  expect(actual.purchases[0].due).toBe('2026-10-22');
  await history.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '提醒中心', exact: true }).click();
  await expect(page.locator('.reminder-columns')).toContainText('已逾期 1 天');
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  history = await openHistory(page);
  await expect(history.locator(`[data-revision-id="${changed.id}"]`)).toBeVisible();
});

test('history: date and procurement changes show real before/after values; backup includes complete versions and can be restored', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByLabel('定位日期', { exact: true }).fill('2026-12-28');
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '竣工联合验收' }));
  let f = page.getByRole('dialog');
  await f.getByLabel('开始日期', { exact: true }).fill('2026-12-27');
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks[2].start).toBe('2026-12-27');
  let h = await openHistory(page),
    card = h.locator('.revision-card').first();
  await card.getByRole('button', { name: '查看修改详情' }).click();
  await expect(card).toContainText('2026-12-28');
  await expect(card).toContainText('2026-12-27');
  await h.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '数据与备份', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载业务与版本备份', exact: true }).click();
  const file = await download,
    archive = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(archive.format).toBe('chunmo-history-backup');
  expect(archive.history.records.length).toBeGreaterThan(0);
  expect(Object.keys(archive.history.snapshots).length).toBeGreaterThan(0);
  expect(archive.data.tasks[2].start).toBe('2026-12-27');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await changeName(page, '备份之后的新名称');
  await page.getByRole('button', { name: '数据与备份', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'versions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).projects[0].name)
    .toBe(archive.data.projects[0].name);
  expect((await versions(page)).records.map((r) => r.id)).toEqual(
    expect.arrayContaining(archive.history.records.map((r: { id: string }) => r.id)),
  );
  h = await openHistory(page);
  await expect(h).toContainText('恢复');
});

test('history: failed atomic restore leaves current data and records intact; expiry hides old versions after reload', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await changeName(page, '变更名称');
  const before = await state(page),
    saved = await versions(page);
  let h = await openHistory(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (key === 'history') throw new DOMException('模拟历史写入失败', 'QuotaExceededError');
      return original.call(this, value, key);
    };
  });
  await h.locator('.revision-card').first().getByRole('button', { name: '恢复到修改前' }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(h.getByRole('alert')).toContainText('恢复失败');
  expect(await state(page)).toEqual(before);
  expect(await versions(page)).toEqual(saved);
  await page.clock.setFixedTime(new Date('2026-11-08T04:00:01Z'));
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  h = await openHistory(page);
  await expect(h).toContainText('暂无修改历史');
  expect(await state(page)).toEqual(before);
});

test('V4 workflow: blank double click creates a project-bound task only; existing bars do not edit and compact trade editor has no personnel registration', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  const before = await state(page);
  await page.locator('.trade-row').nth(2).locator('[data-date="2026-10-24"]').dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).tasks.length).toBe(4);
  expect((await state(page)).purchases).toEqual(before.purchases);
  expect((await state(page)).tasks[3].projectId).toBe('p-home');
  let f;
  await page.getByTestId('task-bar').first().dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click();
  f = page.getByRole('dialog', { name: '编辑工种', exact: true });
  expect((await f.boundingBox())!.width).toBeLessThanOrEqual(520);
  expect((await f.boundingBox())!.height).toBeLessThanOrEqual(750);
  await expect(f.locator('.personnel-fields')).toHaveCount(0);
  await expect(f.locator('.w-color-wheel')).toHaveCSS('width', '104px');
  await f.getByLabel('工种名称', { exact: true }).fill('水电标准工序');
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).trades[1].name).toBe('水电标准工序');
  await expect(page.locator('.trade-menu')).toHaveCount(0);
});

test('people: central safe profile CRUD, role selection, project assignment, global history and existing links survive deletion', async ({
  page,
}) => {
  await boot(page);
  await restore(page);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导出施工工期长图', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '新增人员', exact: true }).click();
  let f = page.getByRole('dialog');
  await f.getByLabel('姓名', { exact: true }).fill('陈设计');
  await f.getByLabel('工作职责', { exact: true }).selectOption('设计人员');
  await f.getByLabel('人员备注', { exact: true }).fill('深化设计');
  await expect(f.getByLabel('手机号', { exact: true })).toHaveCount(0);
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).people?.length).toBe(1);
  const person = (await state(page)).people![0];
  let card = page.locator(`[data-person-id="${person.id}"]`);
  await card.locator('.staff-projects summary').click();
  await card.getByRole('button', { name: '管理项目分配', exact: true }).click();
  f = page.getByRole('dialog');
  await f.getByRole('button', { name: '确认分配', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects[0].staffIds).toEqual([person.id]);
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  expect((await state(page)).projects[0].staffIds).toEqual([person.id]);
  await expect(page.locator('.personnel-summary')).toHaveCount(0);
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' }));
  f = page.getByRole('dialog');
  await f.getByLabel('选择设计人员', { exact: true }).selectOption(person.id);
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).tasks[1].staffIds).toEqual([person.id]);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  card = page.locator(`[data-person-id="${person.id}"]`);
  await card.getByRole('button', { name: '编辑人员', exact: true }).click();
  f = page.getByRole('dialog');
  await f.getByLabel('姓名', { exact: true }).fill('陈主创');
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect(card).toContainText('陈主创');
  await card.getByRole('button', { name: '编辑人员', exact: true }).click();
  await page.getByLabel('可参与新分配', { exact: true }).uncheck();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await card.locator('.staff-projects summary').click();
  await expect(card.getByRole('button', { name: '管理项目分配', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '编辑人员', exact: true }).click();
  await page.getByLabel('可参与新分配', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await card.getByRole('button', { name: '删除人员', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await state(page)).tasks[1].staffIds).toEqual([person.id]);
  expect((await state(page)).people![0].deleted).toBe(true);
  await page.getByRole('button', { name: '版本历史 · 15天', exact: true }).click();
  const h = page.getByRole('dialog', { name: '最近15天修改历史' });
  await expect(h.getByLabel('历史范围', { exact: true })).toHaveValue('@global');
  await h.locator('.revision-card').first().getByRole('button', { name: '恢复到修改前' }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).people![0].deleted).toBeUndefined();
  await h.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator(`[data-person-id="${person.id}"]`)).toBeVisible();
});

test('history: legacy reads invent no versions; rapid live color input records one committed business change and labels fit compact rows', async ({
  page,
}) => {
  await boot(page);
  const d = fixture();
  await page.evaluate(
    async (data) =>
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('chunmo-workspace', 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('workspace', 'readwrite');
          tx.objectStore('workspace').put(data, 'data');
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    d,
  );
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  let h = await openHistory(page);
  await expect(h).toContainText('暂无修改历史');
  await h.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '编辑水电改造', exact: true }).click({ button: 'right' });
  const f = page.getByRole('dialog');
  await f.getByLabel('自定义颜色', { exact: true }).fill('#244e41');
  await f.getByLabel('自定义颜色', { exact: true }).fill('#244e43');
  await f.getByLabel('自定义颜色', { exact: true }).fill('#244e45');
  await expect.poll(async () => (await state(page)).trades[1].color).toBe('#244e45');
  const records = (await versions(page)).records.filter((r) => r.scope === 'p-home');
  expect(records).toHaveLength(1);
  expect(records[0].changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: '水电改造 · 颜色',
        before: d.trades[1].color,
        after: '#244e45',
      }),
    ]),
  );
  await f.getByRole('button', { name: '完成', exact: true }).click();
  for (const label of await page.locator('.trade-label').all()) {
    expect(await label.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  }
  h = await openHistory(page);
  expect((await h.boundingBox())!.height).toBeLessThanOrEqual(750);
  await h.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  h = await openHistory(page);
  const bounds = (await h.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(366);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
});

test('history: full history exposes older-than-eight versions and a deleted project graph can be restored without changing the other project', async ({
  page,
}) => {
  const d = fixture();
  d.projects.push({ ...d.projects[0], id: 'other', name: '保留工地', notes: '其他项目不要覆盖' });
  await boot(page);
  await restore(page, d);
  for (let i = 0; i < 9; i++) await changeName(page, `工地名称第${i + 1}版`);
  let h = await openHistory(page);
  await expect(h.locator('.revision-card')).toHaveCount(8);
  await h.getByRole('button', { name: '查看完整历史', exact: true }).click();
  h = page.getByRole('dialog', { name: '完整修改历史', exact: true });
  expect(await h.locator('.revision-card').count()).toBeGreaterThan(8);
  await h.getByRole('button', { name: '关闭', exact: true }).click();
  const before = await state(page);
  await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
  const f = page.getByRole('dialog');
  await f.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects.length).toBe(1);
  const other = (await state(page)).projects[0];
  await page.getByRole('button', { name: '版本历史 · 15天', exact: true }).click();
  h = page.getByRole('dialog', { name: '最近15天修改历史', exact: true });
  await h.getByRole('button', { name: '查看完整历史', exact: true }).click();
  h = page.getByRole('dialog', { name: '完整修改历史', exact: true });
  await h.getByLabel('历史范围', { exact: true }).selectOption('p-home');
  const deletion = h.locator('.revision-card').first();
  await expect(deletion).toContainText('删除');
  await deletion.getByRole('button', { name: '恢复到修改前', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).projects.length).toBe(2);
  const actual = await state(page);
  expect(actual.tasks).toEqual(before.tasks);
  expect(actual.purchases).toEqual(before.purchases);
  expect(actual.projects.find((p) => p.id === 'other')).toEqual(other);
  expect(actual.projects.find((p) => p.id === 'p-home')?.name).toBe('工地名称第9版');
});
