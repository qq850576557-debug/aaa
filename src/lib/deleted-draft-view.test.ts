import { it, expect } from 'vitest';
import { fixture } from '../../tests/helpers';
import { deletedDraftView } from './deleted-draft-view';
import { staffConflicts } from './readiness';
it('a locally retained deleted-project graph is confined to the journal, while new unsynced projects stay visible', () => {
  const base = fixture(),
    draft = structuredClone(base),
    cloud = structuredClone(base);
  cloud.projects = [];
  cloud.trades = [];
  cloud.tasks = [];
  cloud.purchases = [];
  cloud.notes = [];
  draft.projects.push({ ...base.projects[0], id: 'real-new' });
  const snapshot = structuredClone(draft);
  const visible = deletedDraftView(draft, base, cloud);
  expect(visible.projects.map((x) => x.id)).toEqual(['real-new']);
  expect(visible.tasks).toEqual([]);
  expect(draft).toEqual(snapshot);
});
it('deleted personnel never become active through an old draft; assignments and stored identities remain untouched', () => {
  const base = fixture();
  base.people = [
    { id: 'p', name: '师傅', role: '施工人员', trade: '木工', notes: '', active: true },
  ];
  const draft = structuredClone(base),
    cloud = structuredClone(base);
  cloud.people![0] = { ...cloud.people![0], deleted: true, active: false };
  const visible = deletedDraftView(draft, base, cloud);
  expect(visible.people![0].deleted).toBe(true);
  expect(staffConflicts(visible)).toEqual([]);
  expect(draft.people![0].deleted).toBeUndefined();
});
it('server-rejected revival ids stay in the recovery draft even when its original baseline did not contain them', () => {
  const cloud = fixture();
  cloud.projects = [];
  cloud.trades = [];
  cloud.tasks = [];
  cloud.notes = [];
  cloud.purchases = [];
  const draft = fixture(),
    snapshot = structuredClone(draft);
  const view = deletedDraftView(draft, cloud, cloud, [
    {
      collection: 'projects',
      id: draft.projects[0].id,
      reason: '已删除的记录不能通过旧草稿重新出现',
    },
  ]);
  expect(view.projects).toEqual([]);
  expect(draft).toEqual(snapshot);
});
