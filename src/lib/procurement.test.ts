import { describe, it, expect } from 'vitest';
import {
  emptyData,
  newProject,
  defaultTrades,
  plus,
  stats,
  remainingTime,
  procurementView,
  purchaseDue,
  prepareWorkspace,
  parseBackup,
  projectStatus,
  copyProject,
  type Purchase,
  type Task,
} from './model';
import { savePurchase, confirmPurchaseDeadline } from './procurement';
import { proposeTaskChange } from './scheduling';
const now = '2026-12-31';
function setup() {
  const d = emptyData();
  d.projects = [
    { ...newProject(), id: 'one', name: '甲项目', start: '2026-12-20', end: '2027-02-01' },
    { ...newProject(), id: 'two', name: '乙项目', start: '2026-12-20', end: '2027-02-01' },
  ];
  d.trades = defaultTrades('one');
  return d;
}
function purchase(id = 'purchase', due = now, projectId = 'one'): Purchase {
  return {
    id,
    projectId,
    name: '材料' + id,
    due,
    taskId: '',
    leadDays: 0,
    status: '待采购',
    owner: '',
    notes: '',
  };
}
describe('phase 4 procurement deadlines and shared projections', () => {
  it('computes today, remaining, overdue, leap-day and year boundaries', () => {
    expect(remainingTime(now, now)).toBe('今日到期');
    expect(remainingTime('2027-01-01', now)).toBe('剩余1天');
    expect(remainingTime('2027-01-03', now)).toBe('剩余3天');
    expect(remainingTime('2026-12-29', now)).toBe('已逾期2天');
    expect(remainingTime('2028-03-01', '2028-02-28')).toBe('剩余2天');
  });
  it('uses inclusive 15-day boundary, excludes completed/arrived, and never mixes projects', () => {
    const d = setup();
    d.purchases = [
      purchase('today'),
      purchase('15', plus(now, 15)),
      purchase('16', plus(now, 16)),
      purchase('late', plus(now, -2)),
      purchase('other', now, 'two'),
      { ...purchase('complete'), status: '已完成' },
      { ...purchase('arrived'), status: '已到货' },
    ];
    const view = procurementView(d, 'one', now);
    expect(view.upcoming.map((p) => p.id)).toEqual(['today', '15']);
    expect(view.today.map((p) => p.id)).toEqual(['late', 'today']);
    expect(view.overdue.map((p) => p.id)).toEqual(['late']);
    expect(procurementView(d, 'two', now).today.map((p) => p.id)).toEqual(['other']);
    expect(stats(d, now)).toMatchObject({ todos: 3, upcoming: 3, overduePurchases: 1 });
    d.projects[1].status = '已完工';
    expect(stats(d, now)).toMatchObject({ todos: 2, upcoming: 2 });
  });
  it('creates one independent purchase without duplicating notes or scheduling tasks', () => {
    const d = setup();
    const next = savePurchase(d, { ...purchase(), taskId: 'fake-task', leadDays: 20 });
    expect(next.purchases).toHaveLength(1);
    expect(next.purchases[0]).toMatchObject({
      originalDue: now,
      due: now,
      taskId: '',
      leadDays: 0,
      deadlineMode: 'fixed',
    });
    expect(next.notes).toEqual(d.notes);
    expect(next.tasks).toEqual(d.tasks);
    expect(procurementView(next, 'one', now).today).toHaveLength(1);
  });
  it('allows advancing and restoring within the original deadline, blocks overruns and forged ceilings', () => {
    const d = savePurchase(setup(), purchase('a', '2027-01-03')),
      p = d.purchases[0];
    const early = savePurchase(d, { ...p, due: now });
    expect(early.purchases[0].originalDue).toBe('2027-01-03');
    expect(procurementView(early, 'one', now).today).toHaveLength(1);
    expect(savePurchase(early, { ...early.purchases[0], due: '2027-01-02' }).purchases[0].due).toBe(
      '2027-01-02',
    );
    expect(() =>
      savePurchase(early, {
        ...early.purchases[0],
        due: '2027-01-04',
        originalDue: '2099-01-01',
        approvedDue: '2099-01-01',
      }),
    ).toThrow('不能晚于');
    expect(d.purchases[0].due).toBe('2027-01-03');
  });
  it('retains original deadlines through explicit confirmation chains and JSON restore', () => {
    const d = savePurchase(setup(), purchase());
    expect(() => confirmPurchaseDeadline(d, 'purchase', '2027-01-05', ' ')).toThrow();
    const confirmed = confirmPurchaseDeadline(d, 'purchase', '2027-01-05', '供应商调整，已确认');
    const confirmedTwice = confirmPurchaseDeadline(
      confirmed,
      'purchase',
      '2027-01-07',
      '再次明确调整',
    );
    const p = confirmedTwice.purchases[0];
    expect(p.originalDue).toBe(now);
    expect(p.approvedDue).toBe('2027-01-07');
    expect(p.deadlineHistory?.map((h) => [h.from, h.to])).toEqual([
      [now, '2027-01-05'],
      ['2027-01-05', '2027-01-07'],
    ]);
    expect(parseBackup(JSON.parse(JSON.stringify(confirmedTwice)))).toEqual(confirmedTwice);
    expect(() => savePurchase(confirmedTwice, { ...p, due: '2027-01-08' })).toThrow();
  });
  it('captures the effective legacy linked deadline once, without overwriting its stored fallback or source', () => {
    const d = setup();
    d.tasks = [
      {
        id: 'task',
        projectId: 'one',
        tradeId: d.trades[0].id,
        name: '安装',
        start: '2027-01-03',
        end: '2027-01-04',
        owner: '',
        notes: '',
        status: '未开始',
      },
    ];
    d.purchases = [{ ...purchase('legacy', '2026-12-20'), taskId: 'task', leadDays: 3 }];
    const next = prepareWorkspace(d);
    expect(next.purchases[0].originalDue).toBe(now);
    expect(next.purchases[0].due).toBe('2026-12-20');
    expect(d.purchases[0].originalDue).toBeUndefined();
    expect(prepareWorkspace(next).purchases[0].originalDue).toBe(now);
    expect(
      savePurchase(next, { ...next.purchases[0], due: now, name: '新名称' }).purchases[0]
        .deadlineMode,
    ).toBe('linked');
  });
  it('follows an earlier linked task but never silently postpones procurement when work moves later', () => {
    const d = setup();
    const t: Task = {
      id: 'task',
      projectId: 'one',
      tradeId: d.trades[0].id,
      name: '安装',
      start: '2027-01-03',
      end: '2027-01-04',
      owner: '',
      notes: '',
      status: '未开始',
    };
    d.tasks = [t];
    d.purchases = [{ ...purchase(), taskId: t.id, leadDays: 3 }];
    const later = proposeTaskChange(d, { ...t, start: '2027-01-06', end: '2027-01-07' }).current;
    expect(later.purchases[0].originalDue).toBe(now);
    expect(purchaseDue(later.purchases[0], later)).toBe(now);
    const early = proposeTaskChange(later, {
      ...t,
      start: '2027-01-01',
      end: '2027-01-02',
    }).current;
    expect(purchaseDue(early.purchases[0], early)).toBe('2026-12-29');
    expect(stats(early, now).overduePurchases).toBe(1);
  });
  it('manual procurement dates override the old automatic link without changing any construction tasks', () => {
    const d = setup();
    d.tasks = [
      {
        id: 'task',
        projectId: 'one',
        tradeId: d.trades[0].id,
        name: '安装',
        start: '2027-01-03',
        end: '2027-01-04',
        owner: '',
        notes: '',
        status: '未开始',
      },
    ];
    d.purchases = [{ ...purchase(), taskId: 'task', leadDays: 3 }];
    const next = savePurchase(prepareWorkspace(d), {
      ...prepareWorkspace(d).purchases[0],
      due: '2026-12-30',
    });
    expect(next.tasks).toEqual(d.tasks);
    expect(next.purchases[0]).toMatchObject({
      taskId: 'task',
      deadlineMode: 'fixed',
      originalDue: now,
    });
    expect(purchaseDue(next.purchases[0], next)).toBe('2026-12-30');
  });
  it('rejects forged or incomplete deadline history in backups and cross-project ordinary edits', () => {
    const d = savePurchase(setup(), purchase());
    expect(() => savePurchase(d, { ...d.purchases[0], projectId: 'two' })).toThrow('迁移');
    expect(() =>
      parseBackup({ ...d, purchases: [{ ...d.purchases[0], approvedDue: '2027-01-05' }] }),
    ).toThrow('确认记录');
    expect(() =>
      parseBackup({ ...d, purchases: [{ ...d.purchases[0], due: '2027-01-05' }] }),
    ).toThrow('超过');
  });
  it('supports old project statuses and preserves procurement constraints in independent project copies', () => {
    const d = savePurchase(setup(), purchase());
    d.projects[0].status = '筹备中';
    d.projects[1].status = '进行中';
    expect(projectStatus(d.projects[0].status)).toBe('施工中');
    expect(stats(d, now).ongoing).toBe(2);
    const copied = copyProject(d, d.projects[0]);
    const p = copied.data.purchases.find((p) => p.projectId === copied.project.id)!;
    expect(p.id).not.toBe(d.purchases[0].id);
    expect(p.originalDue).toBe(now);
    expect(parseBackup(copied.data)).toEqual(copied.data);
  });
});
