import { it, expect } from 'vitest';
import { emptyData, newProject, defaultTrades, prepareWorkspace, parseBackup } from './model';
import {
  holdsForFailure,
  planWorkspaceSave,
  withholdResources,
  releaseCorrectedHolds,
  reconcileWorkspaceView,
} from './workspace-save-plan';
const fixture = () => {
  const d = emptyData();
  d.projects = [{ ...newProject(), id: 'site', name: '隔离工地' }];
  d.trades = defaultTrades('site');
  d.people = [{ id: 'old', name: '原师傅', role: '施工人员', trade: '', active: true, notes: '' }];
  d.purchases = [
    {
      id: 'purchase',
      projectId: 'site',
      name: '材料',
      taskId: '',
      due: d.projects[0].start,
      leadDays: 0,
      status: '待采购',
      owner: '',
      notes: '',
    },
  ];
  return prepareWorkspace(d);
};
it('holds only the rejected personnel record while saving unrelated purchases, and preserves the entire source draft', () => {
  const base = fixture(),
    local = structuredClone(base);
  local.people!.push({ ...local.people![0], id: 'new', name: '新增师傅' });
  const held = holdsForFailure(base, local, '资料需修正', [
    { path: ['data', 'people', 1, 'name'], code: 'custom', message: '资料需修正' },
  ]);
  local.purchases[0].status = '已完成';
  const before = structuredClone(local),
    plan = planWorkspaceSave(base, local, base, held);
  expect(plan.data.people).toEqual(base.people);
  expect(plan.data.purchases[0].status).toBe('已完成');
  expect(local).toEqual(before);
  const corrected = structuredClone(local);
  corrected.people![1].name = '已核对师傅';
  const retried = planWorkspaceSave(
    base,
    corrected,
    plan.data,
    releaseCorrectedHolds(local, corrected, plan.holds),
  );
  expect(retried.holds).toHaveLength(0);
  expect(retried.data.people![1].name).toBe('已核对师傅');
});
it('withholds dependent personnel and assignments when their dictionary is rejected without blocking procurement', () => {
  const base = fixture(),
    local = structuredClone(base);
  local.dictionaries = [
    { id: 'wood', label: '木工', kind: 'trade', usage: 'worker', active: true, order: 0 },
  ];
  local.people!.push({ ...local.people![0], id: 'new', name: '新木工', tradeIds: ['wood'] });
  local.trades[0].staffIds = ['new'];
  local.purchases[0].status = '已完成';
  const held = holdsForFailure(base, local, '工种字段不兼容', [
    {
      path: ['data', 'dictionaries', 0, 'usage'],
      code: 'unrecognized_keys',
      message: '字段不兼容',
    },
  ]);
  const plan = planWorkspaceSave(base, local, base, held);
  expect(plan.data.people).toEqual(base.people);
  expect(plan.data.trades).toEqual(base.trades);
  expect(plan.data.purchases[0].status).toBe('已完成');
  expect(() => parseBackup(plan.data)).not.toThrow();
  expect(local.people![1].tradeIds).toEqual(['wood']);
});
it('a real same-person conflict keeps its original baseline across unrelated acknowledgements and cannot be silently overwritten', () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.people![0].name = '本地姓名';
  remote.people![0].name = '云端姓名';
  local.purchases[0].status = '已完成';
  const plan = planWorkspaceSave(base, local, remote);
  expect(plan.data.people![0].name).toBe('云端姓名');
  expect(plan.data.purchases[0].status).toBe('已完成');
  expect(plan.conflicts[0]).toMatchObject({ collection: 'people', id: 'old', field: 'name' });
  const rebased = withholdResources(plan.data, base, plan.holds);
  expect(rebased.people![0].name).toBe('原师傅');
  const repeated = planWorkspaceSave(rebased, local, plan.data, plan.holds);
  expect(repeated.data.people![0].name).toBe('云端姓名');
  expect(repeated.conflicts).toHaveLength(1);
  expect(repeated.data.purchases[0].status).toBe('已完成');
});
it('a conflicting people order is a separate resource and does not suppress unrelated person fields or insert fictitious $order records', () => {
  const base = fixture();
  base.people!.push(...['b', 'c'].map((id) => ({ ...base.people![0], id, name: id })));
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.people!.reverse();
  remote.people!.splice(0, 2, remote.people![1], remote.people![0]);
  local.people![0].notes = '独立备注';
  const plan = planWorkspaceSave(base, local, remote);
  expect(plan.data.people!.map((x) => x.id)).toEqual(remote.people!.map((x) => x.id));
  expect(plan.data.people!.find((x) => x.id === 'c')!.notes).toBe('独立备注');
  expect(plan.conflicts[0].id).toBe('$order');
  expect(() => parseBackup(plan.data)).not.toThrow();
});
it('repeated SSE refreshes advance untouched records and cannot turn remote-only fields into false local conflicts', () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.people![0].name = '本地姓名';
  remote.people![0].name = '云端姓名';
  remote.people![0].notes = '第一版远程备注';
  remote.projects[0].notes = '其他项目内容';
  const view = reconcileWorkspaceView(base, local, remote);
  expect(view.data.projects[0].notes).toBe('其他项目内容');
  expect(view.base.projects[0].notes).toBe('其他项目内容');
  remote.people![0].notes = '第二版远程备注';
  const plan = planWorkspaceSave(view.base, view.data, remote);
  expect(plan.conflicts.map((x) => x.field)).toEqual(['name']);
  expect(plan.data.people![0].notes).toBe('第二版远程备注');
  expect(local.people![0].name).toBe('本地姓名');
});
it('a pending child on a remotely deleted project keeps its graph locally but still receives unrelated project updates', () => {
  const base = fixture();
  base.projects.push({ ...base.projects[0], id: 'other', name: '其他工地' });
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.notes = [
    {
      id: 'pending-child',
      projectId: 'site',
      title: '需保留的现场记录',
      kind: '施工安排',
      date: '2026-10-30',
      reminder: '',
      owner: '',
      content: '',
      done: false,
      pinned: false,
    },
  ];
  remote.projects = remote.projects.filter((x) => x.id !== 'site');
  remote.trades = [];
  remote.purchases = [];
  remote.projects[0].notes = '其他工地最新云端内容';
  const next = reconcileWorkspaceView(base, local, remote);
  expect(next.data.projects.find((x) => x.id === 'other')!.notes).toBe('其他工地最新云端内容');
  expect(next.data.notes[0].title).toBe('需保留的现场记录');
  expect(() => parseBackup(next.data)).not.toThrow();
  const plan = planWorkspaceSave(next.base, next.data, remote);
  expect(plan.conflicts.some((x) => x.id === 'pending-child')).toBe(true);
  expect(plan.data.projects.some((x) => x.id === 'site')).toBe(false);
  expect(plan.data.notes).toHaveLength(0);
});
it('a remote assignment that conflicts with local person deletion does not withhold an unrelated valid purchase change', () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.people = [];
  local.purchases[0].status = '已完成';
  remote.tasks = [
    {
      id: 'remote-task',
      projectId: 'site',
      tradeId: base.trades[0].id,
      name: '另一人新分配的任务',
      start: base.projects[0].start,
      end: base.projects[0].end,
      owner: '',
      notes: '',
      status: '未开始',
      staffIds: ['old'],
    },
  ];
  const plan = planWorkspaceSave(base, local, remote);
  expect(plan.data.people![0].id).toBe('old');
  expect(plan.data.purchases[0].status).toBe('已完成');
  expect(plan.conflicts.map((x) => x.collection)).toEqual(['people']);
  expect(() => parseBackup(plan.data)).not.toThrow();
});
