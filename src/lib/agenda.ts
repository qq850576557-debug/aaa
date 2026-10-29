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
