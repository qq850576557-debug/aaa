import { expect, it } from 'vitest';
import { emptyData, newProject, stats, type Note } from './model';
import { workspaceAgenda } from './agenda';
import { workspaceStats } from './workspace-stats';
import type { WorkRecord } from './records';
const note = (id: string, projectId: string, date: string, patch: Partial<Note> = {}): Note => ({
  id,
  projectId,
  date,
  reminder: '',
  title: id,
  kind: '施工安排',
  done: false,
  pinned: false,
  content: '',
  owner: '',
  ...patch,
});
it('all-site reminders reuse real entries and priority across ongoing sites, without completed/paused sites or duplicate conversions', () => {
  const d = emptyData();
  d.projects = ['a', 'b', 'closed', 'paused'].map((id) => ({
    ...newProject(),
    id,
    name: '同名测试工地',
    status:
      id === 'closed' ? '已完工' : id === 'paused' ? '暂停' : id === 'b' ? '进行中' : '施工中',
  }));
  d.notes = [
    note('late', 'a', '2026-11-09'),
    note('pin', 'b', '2026-11-10', { pinned: true }),
    note('closed', 'closed', '2026-11-10'),
    note('pause', 'paused', '2026-11-10'),
    note('done-old', 'a', '2026-11-09', { done: true }),
    note('next', 'b', '2026-11-11'),
  ];
  d.purchases = [
    {
      id: 'same-id',
      projectId: 'a',
      name: '测试材料',
      taskId: '',
      due: '2026-11-10',
      leadDays: 0,
      status: '已下单',
      owner: '',
      notes: '',
    },
  ];
  const records = [
    {
      id: 'same-id',
      projectId: 'b',
      title: '测试事项',
      nodeDate: '2026-11-10',
      status: '已完成',
      deleted: false,
    },
    { id: 'deleted', projectId: 'a', nodeDate: '2026-11-10', status: '持续跟进', deleted: true },
  ] as WorkRecord[];
  const original = structuredClone({ d, records });
  const overview = workspaceAgenda(d, records, undefined, '2026-11-10');
  expect(overview.today.map((e) => [e.kind, e.id])).toEqual([
    ['legacy', 'pin'],
    ['legacy', 'late'],
    ['purchase', 'same-id'],
    ['record', 'same-id'],
  ]);
  expect(overview.tomorrow.map((e) => e.id)).toEqual(['next']);
  expect(overview.today.at(-1)!.value).toBe(records[0]);
  expect(new Set(overview.items.map((e) => e.kind + ':' + e.id)).size).toBe(overview.items.length);
  expect(
    workspaceAgenda(d, records, 'a', '2026-11-10').today.every((e) => e.projectId === 'a'),
  ).toBe(true);
  expect({ d, records }).toEqual(original);
});
it('overview keeps original global metric rules while explicit project metrics include only that ID', () => {
  const d = emptyData();
  d.projects = ['a', 'b'].map((id) => ({ ...newProject(), id, name: '同名统计测试' }));
  d.notes = [note('a-note', 'a', '2026-11-10')];
  d.purchases = [
    {
      id: 'buy-b',
      projectId: 'b',
      name: '测试材料',
      due: '2026-11-09',
      taskId: '',
      leadDays: 0,
      status: '待采购',
      owner: '',
      notes: '',
    },
  ];
  const records = [
    { id: 'r', projectId: 'b', nodeDate: '2026-11-10', status: '持续跟进', deleted: false },
  ] as WorkRecord[];
  expect(workspaceStats(d, records, '2026-11-10')).toMatchObject({
    total: 2,
    todos: stats(d, '2026-11-10').todos + 1,
    overduePurchases: 1,
  });
  expect(workspaceStats(d, records, '2026-11-10', 'a')).toMatchObject({
    total: 1,
    todos: 1,
    overduePurchases: 0,
  });
  expect(workspaceStats(d, records, '2026-11-10', 'b')).toMatchObject({
    total: 1,
    todos: 2,
    overduePurchases: 1,
  });
});
