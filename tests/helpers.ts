import { resolvedTradeColor } from '../src/lib/trade-colors';
import { expect, type Page, type Locator } from '@playwright/test';
import { emptyData, newProject, defaultTrades, id, type Data } from '../src/lib/model';
export function fixture(): Data {
  const d = emptyData(),
    p = newProject();
  p.id = 'p-home';
  p.name = '栖桐里 · 理想之家';
  p.address = '上海市 · 徐汇区';
  p.owner = '林女士';
  p.manager = '沈设计';
  p.start = '2026-10-22';
  p.end = '2026-12-31';
  p.status = '进行中';
  p.notes = '施工前注意成品保护；每周五向业主同步进度。';
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  d.tasks = [
    {
      id: 't-first',
      projectId: p.id,
      tradeId: d.trades[0].id,
      name: '现场保护与拆改',
      start: '2026-10-22',
      end: '2026-10-25',
      status: '进行中',
      owner: '张师傅',
      notes: '',
    },
    {
      id: 't-water',
      projectId: p.id,
      tradeId: d.trades[1].id,
      name: '水电定位与布线',
      start: '2026-10-26',
      end: '2026-11-05',
      status: '未开始',
      owner: '王师傅',
      notes: '',
    },
    {
      id: 't-last',
      projectId: p.id,
      tradeId: d.trades[7].id,
      name: '竣工联合验收',
      start: '2026-12-28',
      end: '2026-12-31',
      status: '未开始',
      owner: '沈设计',
      notes: '',
    },
  ];
  d.notes = [
    {
      id: id(),
      projectId: p.id,
      title: '确认厨房插座定位',
      kind: '业主确认',
      date: '2026-10-23',
      reminder: '2026-10-23',
      owner: '沈设计',
      content: '与业主确认小家电使用位置，复核台面尺寸。',
      done: false,
      pinned: true,
    },
    {
      id: id(),
      projectId: p.id,
      title: '材料与施工注意事项',
      kind: '项目备忘',
      date: '',
      reminder: '',
      owner: '',
      content: '墙面采用暖白色；木饰面进场前核对色板。',
      done: false,
      pinned: true,
    },
  ];
  d.purchases = [
    {
      id: id(),
      projectId: p.id,
      name: '电线及线管',
      taskId: 't-water',
      due: '2026-10-23',
      leadDays: 3,
      status: '待采购',
      owner: '张师傅',
      notes: '按水电清单核对规格',
    },
  ];
  return d;
}
export function peopleTradeFixture(): Data {
  const d = fixture();
  d.people = Array.from({ length: 8 }, (_, i) => ({
    id: `person-${i}`,
    name: `师傅${i + 1}`,
    role: '施工人员',
    trade: '旧木工',
    active: true,
    notes: `人员备注${i + 1}`,
    tradeIds: i === 0 ? ['worker-wood', 'stage-wood'] : [],
  }));
  for (const [i, role] of (['项目经理', '设计人员', '监理'] as const).entries())
    d.people.push({
      id: `role-${i}`,
      name: role + '甲',
      role,
      trade: '',
      active: true,
      notes: '',
      tradeIds: [],
    });
  d.dictionaries = [
    { id: 'worker-wood', kind: 'trade', label: '木工', active: true, order: 0 },
    { id: 'worker-duplicate', kind: 'trade', label: ' 木作工 ', active: true, order: 1 },
    { id: 'stage-wood', kind: 'trade', label: '木工吊顶', active: true, order: 2 },
  ];
  d.trades[1].staffIds = ['person-0', 'role-0', 'role-1', 'role-2'];
  d.trades[1].personnel = { worker: '旧施工登记', manager: '原经理', designer: '原设计' };
  return d;
}
export async function state(page: Page): Promise<Data> {
  return page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const r = indexedDB.open('chunmo-workspace', 1);
      r.onsuccess = () => {
        const db = r.result,
          q = db.transaction('workspace').objectStore('workspace').get('data');
        q.onsuccess = () => {
          resolve(q.result);
          db.close();
        };
        q.onerror = () => reject(q.error);
      };
      r.onerror = () => reject(r.error);
    });
  });
}
export async function boot(page: Page) {
  await page.goto('/');
  await expect(page.locator('.save-state')).toContainText('已保存');
}
export async function restore(page: Page, d = fixture()) {
  const b = page.getByRole('button', { name: '数据与备份' });
  if (await b.isVisible()) await b.click();
  else await page.getByRole('button', { name: '备份数据' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(d)),
  });
  await expect(page.getByRole('heading', { name: '覆盖当前全部项目数据？' })).toBeVisible();
  await page.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect.poll(async () => (await state(page))?.projects.length).toBe(d.projects.length);
}
export async function closeToast(page: Page) {
  for (const b of await page.getByRole('button', { name: '关闭提示' }).all())
    if (await b.isVisible()) await b.click();
}

export async function editTask(page: Page, target: Locator) {
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑任务详情', exact: true }).click();
}

export async function displayedTradeRGB(page: Page, raw: string) {
  const data = await state(page);
  const trade = data.trades.find((g) => g.color === raw);
  const hex = trade ? resolvedTradeColor(trade) : raw;
  return `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
}
