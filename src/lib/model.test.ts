import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  emptyData,
  newProject,
  defaultTrades,
  id,
  duration,
  plus,
  days,
  parseBackup,
  copyProject,
  removeProject,
  stats,
  purchaseDue,
  lanes,
  dateOK,
  type Data,
  type Task,
} from './model';
import { loadData, saveData } from './storage';
let d: Data;
beforeEach(() => {
  d = emptyData();
  const p = newProject();
  p.name = '春日居';
  p.start = '2026-12-28';
  p.end = '2027-01-10';
  d.projects = [p];
  d.trades = defaultTrades(p.id);
});
function task(start = '2026-12-31', end = '2027-01-02'): Task {
  return {
    id: id(),
    projectId: d.projects[0].id,
    tradeId: d.trades[0].id,
    name: '跨年水电',
    start,
    end,
    status: '未开始',
    owner: '',
    notes: '',
  };
}
describe('calendar and scheduling', () => {
  it('counts both endpoints, leap days and year boundaries', () => {
    expect(duration('2026-12-31', '2027-01-02')).toBe(3);
    expect(plus('2028-02-28', 2)).toBe('2028-03-01');
    expect(days('2028-02-28', '2028-03-01')).toHaveLength(3);
    expect(duration('2026-03-07', '2026-03-10')).toBe(4);
  });
  it('rejects invalid and reversed dates', () => {
    expect(dateOK('2026-02-29')).toBe(false);
    expect(dateOK('2028-02-29')).toBe(true);
    d.tasks = [task('2027-01-03', '2027-01-01')];
    expect(() => parseBackup(d)).toThrow();
  });
  it('lays overlapping tasks in independent lanes', () => {
    const a = task(),
      b = task('2027-01-02', '2027-01-04'),
      c = task('2027-01-03', '2027-01-04');
    expect(lanes([a, b, c])).toHaveLength(2);
  });
  it('moves linked purchase reminders with task start', () => {
    const t = task();
    d.tasks = [t];
    const p = {
      id: id(),
      projectId: t.projectId,
      name: '瓷砖',
      taskId: t.id,
      due: '2026-12-30',
      leadDays: 3,
      status: '待采购' as const,
      owner: '',
      notes: '',
    };
    d.purchases = [p];
    expect(purchaseDue(p, d)).toBe('2026-12-28');
    expect(stats(d, '2026-12-29').overduePurchases).toBe(1);
    d.tasks = [{ ...t, start: '2027-01-05', end: '2027-01-07' }];
    expect(stats(d, '2026-12-29').overduePurchases).toBe(0);
    expect(stats(d, '2026-12-29').upcoming).toBe(1);
  });
});
describe('workspace safety', () => {
  it('copies all linked records using fresh identities', () => {
    d.tasks = [task()];
    d.purchases = [
      {
        id: id(),
        projectId: d.projects[0].id,
        name: '砖',
        taskId: d.tasks[0].id,
        due: '2026-12-30',
        leadDays: 2,
        status: '待采购',
        owner: '',
        notes: '',
      },
    ];
    const result = copyProject(d, d.projects[0]);
    expect(parseBackup(result.data).projects).toHaveLength(2);
    const t = result.data.tasks.find((x) => x.projectId === result.project.id)!;
    expect(t.id).not.toBe(d.tasks[0].id);
    expect(result.data.purchases.at(-1)?.taskId).toBe(t.id);
    expect(removeProject(result.data, result.project.id)).toEqual(d);
  });
  it('rejects duplicate ids and dangling cross-project references', () => {
    d.tasks = [task()];
    d.trades = [];
    expect(() => parseBackup(d)).toThrow();
    d = emptyData();
    d.projects = [newProject()];
    d.projects.push(d.projects[0]);
    expect(() => parseBackup(d)).toThrow();
  });
  it('excludes archived projects from actionable counts', () => {
    d.tasks = [task()];
    expect(stats(d, '2027-01-10').overdueTasks).toBe(1);
    d.projects[0].archived = true;
    expect(stats(d, '2027-01-10').overdueTasks).toBe(0);
  });
  it('persists full structured records to IndexedDB', async () => {
    d.tasks = [task()];
    const saved = await saveData(d);
    expect(await loadData()).toEqual(saved.data);
    expect({ ...saved.data.projects[0], updatedAt: d.projects[0].updatedAt }).toEqual(
      d.projects[0],
    );
  });
  it('rejects malformed backups without overwriting storage', async () => {
    const saved = await saveData(d);
    await expect(saveData({ version: 99 } as unknown as Data)).rejects.toThrow();
    expect(await loadData()).toEqual(saved.data);
  });
});
