import { describe, expect, it } from 'vitest';
import { recordCreate, recordUpdate, visibleRecords, type WorkRecord } from './records';
const value = {
  projectId: 'p',
  title: '核对门套收口',
  nodeDate: '2026-10-29',
  status: '待执行',
  notes: '',
  followUp: '',
};
describe('project follow-up records', () => {
  it('validates real dates, bounded fields and rejects forged server metadata', () => {
    const requestId = '6cd10b31-e89e-4975-8f94-9f65419cb22b';
    expect(recordCreate.parse({ requestId, value }).value.title).toBe(value.title);
    for (const patch of [
      { title: '  ' },
      { nodeDate: '2026-02-30' },
      { status: '管理员' },
      { notes: 'bad\0' },
      { title: 'x'.repeat(241) },
      { updatedBy: 'admin' },
    ])
      expect(recordCreate.safeParse({ requestId, value: { ...value, ...patch } }).success).toBe(
        false,
      );
    expect(recordCreate.safeParse({ requestId, value, actorId: 'admin' }).success).toBe(false);
    expect(recordUpdate.safeParse({ requestId, value, version: 0 }).success).toBe(false);
    expect(recordCreate.safeParse({ requestId, value: { ...value, nodeDate: '' } }).success).toBe(
      true,
    );
  });
  it('filters project/status/full Chinese text without mutating records; sorts undated records last', () => {
    const rows = [
      { ...value, id: 'a', updatedAt: '2026-10-29', nodeDate: '' },
      { ...value, id: 'b', updatedAt: '2026-10-28', projectId: 'other', nodeDate: '2026-10-30' },
      {
        ...value,
        id: 'c',
        updatedAt: '2026-10-27',
        status: '已完成',
        followUp: '现场已核验',
        nodeDate: '2026-10-28',
      },
      { ...value, id: 'd', updatedAt: '2026-10-29', deleted: true },
    ].map((r) => ({ projectName: '春茉工地', ...r })) as WorkRecord[];
    const filter = { project: '', status: '', search: '', sort: 'dateAsc' };
    expect(visibleRecords(rows, filter).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(visibleRecords(rows, { ...filter, sort: 'dateDesc' }).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(
      visibleRecords(rows, { ...filter, project: 'p', status: '已完成', search: '现场' }).map(
        (r) => r.id,
      ),
    ).toEqual(['c']);
    expect(visibleRecords(rows, { ...filter, sort: 'updated' }).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

it('optional owner preserves the exact legacy request shape and rejects invalid or excessive owner values', () => {
  const requestId = '6cd10b31-e89e-4975-8f94-9f65419cb22b';
  expect(recordCreate.parse({ requestId, value }).value).not.toHaveProperty('owner');
  expect(
    recordCreate.parse({ requestId, value: { ...value, owner: '现场负责人' } }).value.owner,
  ).toBe('现场负责人');
  for (const owner of ['x'.repeat(101), 'bad\0'])
    expect(recordCreate.safeParse({ requestId, value: { ...value, owner } }).success).toBe(false);
});
