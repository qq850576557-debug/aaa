import { noteDue, plus, type Data, type Note } from './model';

/** Views of the same saved notes: changing the calendar never duplicates a record. */
export function projectAgenda(data: Data, projectId: string | undefined, date: string) {
  const tomorrowDate = plus(date, 1);
  const notes = data.notes.filter((n) => n.projectId === projectId);
  const order = (a: Note, b: Note) =>
    Number(a.done) - Number(b.done) ||
    Number(b.pinned) - Number(a.pinned) ||
    noteDue(a).localeCompare(noteDue(b)) ||
    a.id.localeCompare(b.id);
  const daily = notes.filter((n) => n.kind !== '项目备忘');
  return {
    date,
    tomorrowDate,
    today: daily
      .filter((n) => !!noteDue(n) && (n.done ? noteDue(n) === date : noteDue(n) <= date))
      .sort(order),
    tomorrow: daily.filter((n) => noteDue(n) === tomorrowDate).sort(order),
    // Preserve the original memo pin priority and stable insertion order.
    memos: notes
      .filter((n) => n.kind === '项目备忘')
      .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
  };
}

import { purchaseDue, purchaseComplete, type Purchase } from './model';
import type { WorkRecord } from './records';
export type AgendaItem = {
  id: string;
  projectId: string;
  title: string;
  date: string;
  status: string;
  done: boolean;
} & (
  | { kind: 'purchase'; value: Purchase }
  | { kind: 'record'; value: WorkRecord }
  | { kind: 'legacy'; value: Note }
);
/** Date projections only: never copy or convert a purchase/board/legacy record. */
export function categorizedAgenda(
  data: Data,
  records: WorkRecord[],
  projectId: string | undefined,
  date: string,
) {
  const items: AgendaItem[] = [
    ...data.purchases
      .filter((p) => p.projectId === projectId)
      .map((p): AgendaItem => ({
        id: p.id,
        kind: 'purchase',
        projectId: p.projectId,
        title: p.name,
        date: purchaseDue(p, data),
        status: p.status,
        done: purchaseComplete(p),
        value: p,
      })),
    ...records
      .filter((r) => !r.deleted && r.projectId === projectId)
      .map((r): AgendaItem => ({
        id: r.id,
        kind: 'record',
        projectId: r.projectId,
        title: r.title,
        date: r.nodeDate,
        status: r.status,
        done: ['已完成', '已取消'].includes(r.status),
        value: r,
      })),
    ...data.notes
      .filter((n) => n.projectId === projectId && n.kind !== '项目备忘')
      .map((n): AgendaItem => ({
        id: n.id,
        kind: 'legacy',
        projectId: n.projectId,
        title: n.title,
        date: noteDue(n),
        status: n.done ? '已完成' : '待执行',
        done: n.done,
        value: n,
      })),
  ];
  const order = (a: AgendaItem, b: AgendaItem) =>
    Number(a.done) - Number(b.done) ||
    Number(b.kind === 'legacy' && b.value.pinned) - Number(a.kind === 'legacy' && a.value.pinned) ||
    a.date.localeCompare(b.date) ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id);
  const tomorrowDate = plus(date, 1);
  return {
    date,
    tomorrowDate,
    today: items.filter((x) => x.date && (x.done ? x.date === date : x.date <= date)).sort(order),
    tomorrow: items.filter((x) => x.date === tomorrowDate).sort(order),
  };
}
