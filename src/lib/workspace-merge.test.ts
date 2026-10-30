import { describe, it, expect } from 'vitest';
import { emptyData, newProject, defaultTrades, prepareWorkspace, parseBackup } from './model';
import { mergeWorkspace } from './workspace-merge';
const fixture = () => {
  const d = emptyData();
  d.projects = [
    { ...newProject(), id: 'a', name: '甲' },
    { ...newProject(), id: 'b', name: '乙' },
  ];
  d.trades = defaultTrades('a');
  d.notes = [
    {
      id: 'n',
      projectId: 'a',
      title: '现场',
      kind: '项目备忘',
      date: '',
      reminder: '',
      owner: '',
      content: '原备注',
      done: false,
      pinned: false,
    },
  ];
  d.purchases = [
    {
      id: 'p',
      projectId: 'a',
      name: '材料',
      taskId: '',
      due: '2026-10-29',
      leadDays: 0,
      status: '待采购',
      owner: '',
      notes: '',
    },
  ];
  return prepareWorkspace(d);
};
describe('safe workspace intent merge', () => {
  it('adding a global person with only a project timestamp must not conflict with an independent project deletion', () => {
    const base = fixture(),
      local = structuredClone(base),
      remote = structuredClone(base);
    local.people = [
      {
        id: 'independent-person',
        name: '新师傅',
        role: '施工人员',
        trade: '',
        active: true,
        notes: '',
      },
    ];
    local.projects[0].updatedAt = '2026-10-30T12:00:00Z';
    remote.projects = remote.projects.filter((x) => x.id !== 'a');
    remote.trades = [];
    remote.notes = [];
    remote.purchases = [];
    const merged = mergeWorkspace(base, local, remote);
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.data.people![0].name).toBe('新师傅');
    expect(merged.data.projects.map((x) => x.id)).toEqual(['b']);
    local.projects[0].notes = '真实项目修改仍须保护';
    expect(mergeWorkspace(base, local, remote).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collection: 'projects', id: 'a', field: '$record' }),
      ]),
    );
  });
  it('merges independent projects/records and different fields without changing its inputs', () => {
    const b = fixture(),
      l = structuredClone(b),
      r = structuredClone(b);
    l.purchases[0].status = '已完成';
    r.projects[1].notes = '乙更新';
    l.projects[0].updatedAt = '2026-10-29T01:00:00Z';
    r.projects[0].updatedAt = '2026-10-29T02:00:00Z';
    const snapshots = JSON.stringify([b, l, r]),
      m = mergeWorkspace(b, l, r);
    expect(m.conflicts).toHaveLength(0);
    expect(m.data.purchases[0].status).toBe('已完成');
    expect(m.data.projects[1].notes).toBe('乙更新');
    expect(() => parseBackup(m.data)).not.toThrow();
    expect(JSON.stringify([b, l, r])).toBe(snapshots);
    l.notes[0].title = '本地标题';
    r.notes[0].content = '云端备注';
    expect(mergeWorkspace(b, l, r).data.notes[0]).toMatchObject({
      title: '本地标题',
      content: '云端备注',
    });
  });
  it('protects same fields, concurrent deletion/edits and ID collisions, and allows explicit resolutions', () => {
    const b = fixture(),
      l = structuredClone(b),
      r = structuredClone(b);
    l.notes[0].content = '本地';
    r.notes[0].content = '云端';
    const m = mergeWorkspace(b, l, r);
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]).toMatchObject({
      id: 'n',
      field: 'content',
      base: '原备注',
      local: '本地',
      remote: '云端',
    });
    const accepted = mergeWorkspace(b, l, r, { [m.conflicts[0].key]: 'remote' });
    expect(accepted.conflicts).toHaveLength(0);
    expect(accepted.data.notes[0].content).toBe('云端');
    l.notes = [];
    expect(mergeWorkspace(b, l, r).conflicts[0].field).toBe('$record');
    const empty = emptyData(),
      a = structuredClone(empty),
      c = structuredClone(empty);
    a.projects = [{ ...b.projects[0] }];
    c.projects = [{ ...b.projects[0], name: '相同ID不同项目' }];
    expect(mergeWorkspace(empty, a, c).conflicts).toHaveLength(1);
  });
  it('merges set membership safely and keeps conflicting project reorders explicit', () => {
    const b = fixture(),
      l = structuredClone(b),
      r = structuredClone(b);
    b.nameHistory = ['旧'];
    l.nameHistory = ['旧', '本地'];
    r.nameHistory = ['云端'];
    const m = mergeWorkspace(b, l, r);
    expect(m.data.nameHistory).toEqual(['云端', '本地']);
    b.projects.push({ ...newProject(), id: 'c' });
    const left = structuredClone(b),
      right = structuredClone(b);
    left.projects = [b.projects[1], b.projects[0], b.projects[2]];
    right.projects = [b.projects[0], b.projects[2], b.projects[1]];
    expect(mergeWorkspace(b, left, right).conflicts.some((c) => c.id === '$order')).toBe(true);
  });
  it('identical repeats produce no intent changes and latest untouched values always survive', () => {
    const b = fixture(),
      l = structuredClone(b);
    l.purchases[0].notes = '已提交';
    const r = structuredClone(l);
    r.notes[0].content = '之后的独立修改';
    const m = mergeWorkspace(b, l, r);
    expect(m.conflicts).toHaveLength(0);
    expect(m.data).toEqual(r);
  });
  it('requires explicit record choices when separate valid changes break a relationship', () => {
    const b = fixture(),
      l = structuredClone(b),
      r = structuredClone(b);
    l.notes.push({ ...l.notes[0], id: 'new', title: '已删除工地上的草稿' });
    r.projects = r.projects.filter((p) => p.id !== 'a');
    r.trades = [];
    r.notes = [];
    r.purchases = [];
    expect(() => parseBackup(l)).not.toThrow();
    expect(() => parseBackup(r)).not.toThrow();
    const m = mergeWorkspace(b, l, r);
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]).toMatchObject({ collection: 'notes', id: 'new', field: '$record' });
    const accepted = mergeWorkspace(b, l, r, { [m.conflicts[0].key]: 'remote' });
    expect(accepted.conflicts).toHaveLength(0);
    expect(() => parseBackup(accepted.data)).not.toThrow();
    expect(l.notes.some((n) => n.id === 'new')).toBe(true); // The source draft is never mutated.
  });
  it('schedule undo only reverses its own edit and rejects a later same-field change', () => {
    const before = fixture(),
      after = structuredClone(before);
    after.notes[0].date = '2026-11-01';
    const latest = structuredClone(after);
    latest.projects[1].notes = '其他人已提交';
    const undo = mergeWorkspace(after, before, latest);
    expect(undo.conflicts).toHaveLength(0);
    expect(undo.data.notes[0].date).toBe('');
    expect(undo.data.projects[1].notes).toBe('其他人已提交');
    latest.notes[0].date = '2026-11-02';
    expect(mergeWorkspace(after, before, latest).conflicts[0].field).toBe('date');
  });
});
