import type { Data } from './model';
/** Display only: the original journal remains intact for explicit review/export.
 * A repaired local graph must not make a remotely deleted parent look live again. */
export function deletedDraftView(
  draft: Data,
  base: Data,
  cloud: Data,
  holds: { collection: string; id: string; reason: string }[] = [],
): Data {
  const quarantined = holds.filter((x) =>
    ['已删除的记录不能通过', '相同资料的人员档案已删除', '已有相同姓名和资料的人员档案'].some(
      (message) => x.reason.includes(message),
    ),
  );
  const projectIds = new Set(cloud.projects.map((x) => x.id));
  const removed = new Set(base.projects.filter((x) => !projectIds.has(x.id)).map((x) => x.id));
  for (const x of quarantined) if (x.collection === 'projects') removed.add(x.id);
  const cloudPeople = new Map((cloud.people ?? []).map((x) => [x.id, x]));
  const removedPeople = new Set(
    (base.people ?? []).filter((x) => !cloudPeople.has(x.id)).map((x) => x.id),
  );
  for (const x of quarantined)
    if (x.collection === 'people' && !cloudPeople.has(x.id)) removedPeople.add(x.id);
  const softDeleted = new Set((cloud.people ?? []).filter((x) => x.deleted).map((x) => x.id));
  if (!removed.size && !removedPeople.size && !softDeleted.size) return draft;
  const staff = <T extends { staffIds?: string[] }>(row: T): T =>
    removedPeople.size && row.staffIds
      ? { ...row, staffIds: row.staffIds.filter((id) => !removedPeople.has(id)) }
      : row;
  return {
    ...draft,
    projects: draft.projects.filter((x) => !removed.has(x.id)).map(staff),
    trades: draft.trades.filter((x) => !removed.has(x.projectId)).map(staff),
    tasks: draft.tasks.filter((x) => !removed.has(x.projectId)).map(staff),
    notes: draft.notes.filter((x) => !removed.has(x.projectId)),
    purchases: draft.purchases.filter((x) => !removed.has(x.projectId)),
    ...(draft.people
      ? {
          people: draft.people
            .filter((x) => !removedPeople.has(x.id))
            .map((x) => (softDeleted.has(x.id) ? { ...x, deleted: true, active: false } : x)),
        }
      : {}),
  };
}
