// Shared by desktop-model tests and the generated Mini Program bundle. No new
// business models: reuse exactly the existing deadline, agenda and save planners.
import {
  purchaseStatuses,
  purchaseDue,
  purchaseSchema,
  plus,
  distance,
  type Data,
  type Purchase,
} from './model';
import { savePurchase } from './procurement';
import { categorizedAgenda } from './agenda';
import { makeWorkspaceDelta } from './workspace-delta';
import {
  recordData,
  recordCreate,
  recordUpdate,
  editableRecordStatuses,
  type WorkRecord,
} from './records';
export { purchaseStatuses, editableRecordStatuses, recordData };
export function shanghaiDay(at = Date.now()) {
  return new Date(at + 8 * 3600000).toISOString().slice(0, 10);
}
export function workbenchView(
  data: Data,
  records: WorkRecord[],
  actor: { id: string; name: string },
  day = shanghaiDay(),
) {
  const items = data.projects
    .flatMap((p) => categorizedAgenda(data, records, p.id, day).items)
    .filter((i) => i.kind !== 'legacy')
    .map((i) => ({
      ...i,
      projectName: data.projects.find((p) => p.id === i.projectId)?.name || '历史工地',
      owner: i.value.owner || '',
      mine: i.value.mentionIds?.includes(actor.id) || i.value.owner === actor.name,
      remaining: i.date ? distance(day, i.date) : null,
    }))
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    );
  return {
    day,
    tomorrow: plus(day, 1),
    items,
    today: items.filter((i) => !i.done && i.date === day),
    tomorrowItems: items.filter((i) => !i.done && i.date === plus(day, 1)),
    overdue: items.filter((i) => !i.done && !!i.date && i.date < day),
  };
}
export function planPurchase(
  state: { data: Data; revision: number; resourceProofs?: Record<string, string> },
  fields: Partial<Purchase>,
  requestId: string,
  id: string,
) {
  const old = state.data.purchases.find((p) => p.id === id);
  const value = purchaseSchema.parse({
    ...(old || { id, taskId: '', leadDays: 0, owner: '', notes: '', status: '待采购' }),
    ...fields,
    id,
  });
  // Unedited linked deadlines must retain their actual calculated date.
  if (old && fields.due === undefined) value.due = purchaseDue(old, state.data);
  const data = savePurchase(state.data, value);
  return makeWorkspaceDelta(
    state.data,
    data,
    state.revision,
    requestId,
    state.resourceProofs || {},
  );
}
export function planRecord(value: unknown, requestId: string, old?: WorkRecord) {
  return old
    ? recordUpdate.parse({ requestId, version: old.version, value })
    : recordCreate.parse({ requestId, value });
}
