import { it, expect } from 'vitest';
import { categorizedAgenda } from './agenda';
import { emptyData } from './model';
import type { WorkRecord } from './records';
it('projects live records by site/date without copying, excludes deletion and retains completed dates', () => {
  const d = emptyData();
  d.purchases = [
    {
      id: 'p',
      projectId: 'one',
      name: '购买',
      due: '2026-11-01',
      status: '已完成',
      taskId: '',
      leadDays: 0,
      owner: '',
      notes: '',
    },
  ];
  const r = {
    id: 'r',
    projectId: 'one',
    title: '检查',
    nodeDate: '2026-11-01',
    status: '已完成',
    deleted: false,
  } as WorkRecord;
  const items = () => categorizedAgenda(d, [r], 'one', '2026-11-01').items;
  expect(items()).toHaveLength(2);
  r.nodeDate = '2026-11-02';
  expect(items().filter((x) => x.date === '2026-11-01')).toHaveLength(1);
  r.projectId = 'two';
  expect(items()).toHaveLength(1);
  expect(categorizedAgenda(d, [r], 'two', '2026-11-02').items).toHaveLength(1);
  r.deleted = true;
  expect(categorizedAgenda(d, [r], 'two', '2026-11-02').items).toHaveLength(0);
  expect(d.purchases).toHaveLength(1);
});
