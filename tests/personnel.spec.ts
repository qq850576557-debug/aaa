import { test, expect, type Page } from '@playwright/test';
import { boot, restore, fixture, state, editTask, closeToast } from './helpers';
import type { Data } from '../src/lib/model';
function data(): Data {
  const d = fixture();
  d.people = [
    { id: 'w', name: '张师傅', role: '施工人员', trade: '旧水电', notes: '', active: true },
  ];
  d.trades[1].id = 'g:water';
  d.tasks[1].tradeId = 'g:water';
  d.trades[1].staffIds = ['w'];
  const p = { ...d.projects[0], id: 'second', name: '第二工地', address: '2号房' };
  d.projects.push(p);
  d.trades.push({ ...d.trades[1], id: 'g2', projectId: p.id, staffIds: ['w'] });
  d.tasks.push({
    ...d.tasks[1],
    id: 't2',
    projectId: p.id,
    tradeId: 'g2',
    name: '第二工地施工',
    start: '2026-10-28',
    end: '2026-11-02',
  });
  return d;
}
async function revisions(page: Page) {
  return page.evaluate(
    async () =>
      await new Promise<any>((resolve, reject) => {
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
      }),
  );
}
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-24T04:00:00Z'));
});
test('V4 compact personnel editor preserves category, legacy trade and disabled dictionary references', async ({
  page,
}) => {
  const d = data();
  d.dictionaries = [
    { id: 'cat', kind: 'category', label: '合作师傅', active: true, order: 0 },
    { id: 'water', kind: 'trade', label: '水电专业', active: true, order: 1 },
    { id: 'old', kind: 'trade', label: '旧专业', active: false, order: 2 },
  ];
  d.people![0].categoryId = 'cat';
  d.people![0].tradeIds = ['old'];
  await boot(page);
  await restore(page, d);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '类别与工种字典', exact: true })).toHaveCount(0);
  const card = page.locator('[data-person-id="w"]');
  await card.getByRole('button', { name: '编辑人员', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑人员档案' });
  await expect(editor.getByLabel('人员类别', { exact: true })).toHaveCount(0);
  await expect(editor.getByText('原工种文字（兼容保留）', { exact: true })).toHaveCount(0);
  await editor.getByLabel('人员工种水电专业', { exact: true }).check();
  await editor.getByLabel('姓名', { exact: true }).fill('张师傅更新');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).people![0].name).toBe('张师傅更新');
  const saved = await state(page);
  expect(saved.people![0].categoryId).toBe('cat');
  expect(saved.people![0].trade).toBe('旧水电');
  expect(saved.people![0].tradeIds).toEqual(['old', 'water']);
  expect(saved.dictionaries).toEqual(d.dictionaries);
  await page.getByRole('button', { name: '版本历史 · 15天', exact: true }).click();
  const history = page.getByRole('dialog', { name: '最近15天修改历史' });
  await history
    .locator('.revision-card')
    .first()
    .getByRole('button', { name: '恢复到修改前' })
    .click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).people![0].name).toBe('张师傅');
});

test('conflicts: task dates and personnel allocation synchronize both directions and historical restore recomputes overlaps', async ({
  page,
}) => {
  const d = data();
  await boot(page);
  await restore(page, d);
  await expect(page.locator('.conflict-panel')).toContainText('张师傅');
  await expect(page.locator('.conflict-panel')).toContainText('2026-10-28 — 2026-11-02');
  await page.locator('.conflict-panel summary').click();
  await expect(page.locator('.conflict-panel')).toContainText('2号房');
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  let card = page.locator('[data-person-id="w"]');
  await card.locator('.staff-projects summary').click();
  await expect(card.locator('.staff-project-names')).toContainText('第二工地');
  await expect(card.locator('.staff-project-names')).not.toContainText('计划进场');
  expect((await state(page)).tasks.find((t) => t.id === 't-water')?.start).toBe('2026-10-26');
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await editTask(page, page.getByTestId('task-bar').filter({ hasText: '水电定位与布线' }));
  let editor = page.getByRole('dialog');
  await editor.getByLabel('开始日期', { exact: true }).fill('2026-11-10');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const proposal = page.getByRole('dialog', { name: '是否顺延后续工期？' });
  if (await proposal.isVisible())
    await proposal.getByRole('button', { name: '仅调整当前工序', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-11-10');
  await expect(page.locator('.conflict-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  card = page.locator('[data-person-id="w"]');
  await card.locator('.staff-projects summary').click();
  expect((await state(page)).tasks.find((t) => t.id === 't-water')?.start).toBe('2026-11-10');
  await expect(card.locator('.staff-project-names')).not.toContainText('2026-11-10');
  await card.getByRole('button', { name: '管理项目分配', exact: true }).click();
  editor = page.getByRole('dialog');
  await editor.getByLabel('分配位置', { exact: true }).selectOption(`trade:${d.trades[1].id}`);
  await editor.getByRole('button', { name: '解除此处分配', exact: true }).click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page)).trades[1].staffIds).toEqual([]);
  expect((await state(page)).tasks.find((t) => t.id === 't2')).toEqual(
    d.tasks.find((t) => t.id === 't2'),
  );
  const h = await revisions(page),
    target = h.records.findLast(
      (r: any) => r.scope === 'p-home' && r.changes.some((c: any) => c.label.includes('开始日期')),
    );
  await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '安排水电改造施工人员', exact: true }),
  ).toContainText('未安排');
  await closeToast(page);
  await page.getByRole('button', { name: '版本历史 · 15天', exact: true }).click();
  const history = page.getByRole('dialog', { name: '最近15天修改历史', exact: true });
  await history
    .locator(`[data-revision-id="${target.id}"]`)
    .getByRole('button', { name: '恢复到修改前' })
    .click();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).tasks.find((t) => t.id === 't-water')?.start)
    .toBe('2026-10-26');
  await history.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.conflict-panel')).toContainText('张师傅');
  await expect(
    page.getByRole('button', { name: '安排水电改造施工人员', exact: true }),
  ).toContainText('张师傅');
  expect((await state(page)).tasks.find((t) => t.id === 't2')).toEqual(
    d.tasks.find((t) => t.id === 't2'),
  );
  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await expect(page.locator('.conflict-panel')).toContainText('张师傅');
});

test('privacy: local profile has no rating input, rating payload or private information in ordinary backups', async ({
  page,
}) => {
  await boot(page);
  await restore(page, data());
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.locator('[data-person-id="w"]').getByText('内部评价', { exact: true }).click();
  await expect(page.locator('[data-person-id="w"]')).toContainText('尚未开放');
  await page.getByRole('button', { name: '新增人员', exact: true }).click();
  const editor = page.getByRole('dialog');
  for (const label of ['星级', '评价备注', '手机号', '出生日期'])
    await expect(editor.getByLabel(label, { exact: true })).toHaveCount(0);
  const raw = JSON.stringify(await state(page));
  expect(raw).not.toContain('reviews');
  expect(raw).not.toContain('ratings');
});

test('V4 new personnel can select standard trades without a dictionary management screen', async ({
  page,
}) => {
  await boot(page);
  await restore(page, data());
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await page.getByRole('button', { name: '新增人员', exact: true }).click();
  const f = page.getByRole('dialog', { name: '新增人员档案' });
  await f.getByLabel('姓名', { exact: true }).fill('新水电师傅');
  await f.getByLabel('人员工种水电改造', { exact: true }).check();
  await f.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await state(page)).people!.length).toBe(2);
  const d = await state(page),
    p = d.people!.find((p) => p.name === '新水电师傅')!;
  expect(d.dictionaries?.find((t) => t.id === p.tradeIds![0])?.label).toBe('水电改造');
  expect(d.people![0].trade).toBe('旧水电');
  await expect(page.locator(`[data-person-id="${p.id}"]`)).toContainText('水电改造');
});
