import { describe, expect, it } from 'vitest';
import { emptyData, type Note } from './model';
import { projectAgenda } from './agenda';
const n = (id: string, date: string, patch: Partial<Note> = {}): Note => ({
  id,
  projectId: 'a',
  title: id,
  kind: '施工安排',
  date,
  reminder: '',
  owner: '',
  content: '',
  done: false,
  pinned: false,
  ...patch,
});
describe('date-based project agenda', () => {
  it('retains memo pin priority even when a pinned memo was marked complete', () => {
    const d = emptyData();
    d.notes = [
      n('ordinary', '', { kind: '项目备忘' }),
      n('pinned-done', '', { kind: '项目备忘', done: true, pinned: true }),
      n('last', '', { kind: '项目备忘' }),
    ];
    expect(projectAgenda(d, 'a', '2026-10-29').memos.map((n) => n.id)).toEqual([
      'pinned-done',
      'ordinary',
      'last',
    ]);
  });
  it('separates today/tomorrow/memos and other projects without changing original records', () => {
    const d = emptyData();
    d.notes = [
      n('late', '2026-10-28'),
      n('today', '2026-10-29'),
      n('tomorrow', '2026-10-30'),
      n('future', '2026-11-01'),
      n('memo', '2026-10-29', { kind: '项目备忘' }),
      n('other', '2026-10-30', { projectId: 'b' }),
      n('finished-old', '2026-10-28', { done: true }),
    ];
    const original = structuredClone(d),
      a = projectAgenda(d, 'a', '2026-10-29');
    expect(a.today.map((n) => n.id)).toEqual(['late', 'today']);
    expect(a.tomorrow.map((n) => n.id)).toEqual(['tomorrow']);
    expect(a.memos.map((n) => n.id)).toEqual(['memo']);
    expect(d).toEqual(original);
    expect(new Set([...a.today, ...a.tomorrow, ...a.memos].map((n) => n.id)).size).toBe(4);
  });
  it('year-end and leap-day rollover reuse IDs; completed notes remain saved', () => {
    const d = emptyData();
    d.notes = [n('pending', '2027-01-01'), n('finished', '2027-01-01', { done: true })];
    const before = projectAgenda(d, 'a', '2026-12-31'),
      after = projectAgenda(d, 'a', '2027-01-01');
    expect(before.tomorrowDate).toBe('2027-01-01');
    expect(after.today.map((n) => n.id)).toEqual(before.tomorrow.map((n) => n.id));
    expect(after.tomorrow).toHaveLength(0);
    expect(projectAgenda(d, 'a', '2027-01-02').today.map((n) => n.id)).toEqual(['pending']);
    expect(d.notes).toHaveLength(2);
    expect(projectAgenda(d, 'a', '2028-02-28').tomorrowDate).toBe('2028-02-29');
    expect(projectAgenda(d, 'a', '2028-02-29').tomorrowDate).toBe('2028-03-01');
  });
  it('editing dates, completing and deleting use the single saved note source; purchases never become agenda entries', () => {
    const d = emptyData();
    d.notes = [n('one', '2026-10-30')];
    const edited = { ...d, notes: d.notes.map((n) => ({ ...n, date: '2026-10-29', done: true })) };
    expect(projectAgenda(edited, 'a', '2026-10-29').tomorrow).toHaveLength(0);
    expect(projectAgenda(edited, 'a', '2026-10-29').today[0]).toMatchObject({
      id: 'one',
      done: true,
    });
    expect(projectAgenda({ ...d, notes: [] }, 'a', '2026-10-29').tomorrow).toHaveLength(0);
    expect(projectAgenda(d, undefined, '2026-10-29').tomorrow).toHaveLength(0);
  });
});

import { categorizedAgenda } from './agenda';
import type { WorkRecord } from './records';
it('projects procurement and board records by type/date without copies, conversions or cross-project leakage', () => {
  const data = emptyData();
  data.purchases = [
    {
      id: 'same-id',
      projectId: 'a',
      name: '采购电线',
      due: '2026-12-31',
      taskId: '',
      leadDays: 0,
      status: '待采购',
      owner: '甲',
      notes: '',
    },
  ];
  data.notes = [n('memo', '', { kind: '项目备忘' }), n('old-daily', '2027-01-01')];
  const records = [
    {
      id: 'same-id',
      projectId: 'a',
      title: '复核尺寸',
      nodeDate: '2027-01-01',
      status: '待执行',
      deleted: false,
    },
    {
      id: 'other',
      projectId: 'b',
      title: '其他工地',
      nodeDate: '2027-01-01',
      status: '紧急',
      deleted: false,
    },
    {
      id: 'deleted',
      projectId: 'a',
      title: '已删除',
      nodeDate: '2027-01-01',
      status: '待执行',
      deleted: true,
    },
  ] as WorkRecord[];
  const before = structuredClone({ data, records });
  const first = categorizedAgenda(data, records, 'a', '2026-12-31');
  expect(first.today.map((x) => [x.kind, x.id])).toEqual([['purchase', 'same-id']]);
  expect(first.tomorrow.map((x) => x.kind).sort()).toEqual(['legacy', 'record']);
  expect(first.tomorrow.find((x) => x.kind === 'record')!.value).toBe(records[0]);
  const next = categorizedAgenda(data, records, 'a', '2027-01-01');
  expect(next.today).toHaveLength(3);
  expect(next.tomorrow).toHaveLength(0);
  records[0].nodeDate = '2027-01-03';
  expect(
    categorizedAgenda(data, records, 'a', '2027-01-01').today.some((x) => x.kind === 'record'),
  ).toBe(false);
  records[0].nodeDate = '2027-01-01';
  expect({ data, records }).toEqual(before);
  expect(categorizedAgenda(data, records, undefined, '2027-01-01').today).toEqual([]);
});
it('completion, cancellation and deletion remain in their original stores and never become new records', () => {
  const data = emptyData();
  data.purchases = [
    {
      id: 'p',
      projectId: 'a',
      name: '采购',
      due: '2026-10-29',
      taskId: '',
      leadDays: 0,
      status: '已完成',
      owner: '',
      notes: '',
    },
  ];
  const records = [
    {
      id: 'r',
      projectId: 'a',
      title: '事项',
      nodeDate: '2026-10-29',
      status: '已完成',
      deleted: false,
    },
  ] as WorkRecord[];
  expect(categorizedAgenda(data, records, 'a', '2026-10-29').today.every((x) => x.done)).toBe(true);
  expect(categorizedAgenda(data, records, 'a', '2026-10-30').today).toHaveLength(0);
  records[0].deleted = true;
  expect(categorizedAgenda(data, records, 'a', '2026-10-29').today.map((x) => x.kind)).toEqual([
    'purchase',
  ]);
  expect(records).toHaveLength(1);
  expect(data.purchases).toHaveLength(1);
});

it('retains pinned legacy daily-note priority without changing the saved records', () => {
  const data = emptyData();
  data.notes = [n('older', '2026-10-28'), n('pinned', '2026-10-29', { pinned: true })];
  expect(categorizedAgenda(data, [], 'a', '2026-10-30').today.map((x) => x.id)).toEqual([
    'pinned',
    'older',
  ]);
  expect(data.notes.map((x) => x.id)).toEqual(['older', 'pinned']);
});
