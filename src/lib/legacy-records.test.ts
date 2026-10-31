import { it, expect } from 'vitest';
import { legacyCandidates, visibleLegacyNotes, legacyKey } from './legacy-records';
import { emptyData, newProject, type Note } from './model';
const note = (
  id: string,
  title: string,
  kind: Note['kind'] = '项目备忘',
  date = '2026-10-31',
): Note => ({
  id,
  projectId: 'site',
  title,
  kind,
  date,
  reminder: '',
  owner: '原负责人',
  content: '',
  done: false,
  pinned: false,
});
it('classifies business intent before material nouns, respects structured types, and holds ambiguous cases', () => {
  const d = emptyData();
  d.notes = [
    note('buy', '购买灯具', '材料采购'),
    note('inspect', '检查灯具安装位置'),
    note('arrival', '跟进五金到货', '到货验收'),
    note('mixed', '购买瓷砖并检查施工质量'),
    note('noun', '瓷砖'),
    note('reference', '长期说明：材料保养说明书'),
    note('conflict', '检查灯具安装点位', '材料采购'),
    note('undated', '订购灯带', '材料采购', ''),
  ];
  const before = structuredClone(d);
  expect(legacyCandidates(d, []).map((r) => r.kind)).toEqual([
    'purchase',
    'record',
    'purchase',
    'pending',
    'pending',
    'reference',
    'pending',
    'pending',
  ]);
  expect(d).toEqual(before);
});
it('keeps exact existing records but flags possible duplicates and never matches across sites', () => {
  const d = emptyData();
  d.notes = [note('a', '确认现场尺寸', '现场复核')];
  const r = {
    id: 'target',
    projectId: 'site',
    title: '确认现场尺寸',
    nodeDate: '2026-10-31',
    owner: '原负责人',
    notes: '',
    status: '待执行',
    deleted: false,
  } as any;
  expect(legacyCandidates(d, [r])[0].matches[0]).toMatchObject({ id: 'target', exact: true });
  expect(legacyCandidates(d, [{ ...r, projectId: 'other' }])[0].matches).toEqual([]);
  expect(legacyCandidates(d, [{ ...r, notes: '另一次工作' }])[0].kind).toBe('pending');
  const deleted = legacyCandidates(d, [{ ...r, deleted: true }])[0];
  expect(deleted.kind).toBe('pending');
  expect(deleted.matches[0]).toMatchObject({ exact: false, deleted: true });
});
it('retains completion and every source field; suppresses only confirmed unchanged projections while retaining drafts', () => {
  const d = emptyData();
  d.projects = [{ ...newProject(), id: 'site', name: '工地', notes: '长期施工说明' }];
  d.notes = [
    {
      ...note('source', '原已完成事项', '施工安排'),
      done: true,
      taskId: 'task',
      reminder: '2026-11-01',
      content: '原始完整内容',
    },
  ];
  const row = legacyCandidates(d, [])[0];
  expect(row.done).toBe(true);
  expect(row.original).toEqual(d.notes[0]);
  const links = [
    {
      sourceKey: legacyKey('note', 'site', 'source'),
      sourceId: 'source',
      projectId: 'site',
      sourceHash: 'x',
      targetKind: 'record',
      targetId: 'target',
      matchesCurrent: true,
    },
  ];
  expect(visibleLegacyNotes(d.notes, d.notes, links)).toEqual([]);
  expect(
    visibleLegacyNotes([{ ...d.notes[0], content: '未保存修改' }], d.notes, links),
  ).toHaveLength(1);
  expect(
    visibleLegacyNotes(d.notes, d.notes, [{ ...links[0], matchesCurrent: false }]),
  ).toHaveLength(1);
  expect(d.notes).toHaveLength(1);
});

it('holds duplicate old sources rather than creating duplicate targets automatically', () => {
  const d = emptyData();
  d.notes = [note('one', '检查灯具安装位置'), note('two', '检查灯具安装位置')];
  expect(legacyCandidates(d, []).map((r) => r.kind)).toEqual(['pending', 'pending']);
});

it('does not archive ambiguous project descriptions just because they came from a notes field', () => {
  const d = emptyData();
  d.projects = [
    { ...newProject(), id: 'one', notes: '再看看' },
    { ...newProject(), id: 'two', notes: '参考资料：长期施工说明' },
    { ...newProject(), id: 'three', notes: '确认尺寸后协调安装' },
  ];
  expect(legacyCandidates(d, []).map((r) => r.kind)).toEqual(['pending', 'reference', 'record']);
  expect(d.projects[0].notes).toBe('再看看');
});
