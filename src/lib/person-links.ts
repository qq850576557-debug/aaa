import type { Data, Person } from './model';
import type { Assessment } from './assessments';
// Explicitly confirmed aliases only. Names never determine identity.
export function primaryPerson(people: Person[], id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const next = people.find((p) => p.id === current)?.identityLink?.personId;
    if (!next) return current;
    if (!people.some((p) => p.id === next)) return id;
    current = next;
  }
  return id;
}
export function linkedAssessmentView(records: Assessment[], data: Data): Assessment[] {
  return records.map((r) => {
    const personId = primaryPerson(data.people ?? [], r.personId);
    return {
      ...r,
      personId,
      personName: data.people?.find((p) => p.id === personId)?.name ?? r.personName,
    };
  });
}
export function duplicatePeople(people: Person[], person: Person) {
  const trades = (p: Person) =>
    p.tradeIds?.length ? [...p.tradeIds].sort().join('|') : p.trade.trim();
  return people.filter(
    (p) =>
      p.id !== person.id &&
      p.name.trim() === person.name.trim() &&
      p.role === person.role &&
      trades(p) === trades(person),
  );
}
export function linkedDailyView(records: Assessment[], data: Data) {
  const original = new Map(records.map((r) => [r.id, r]));
  return dailyAssessments(linkedAssessmentView(records, data)).map((r) => ({
    ...r,
    sources: r.sources.map((s) => original.get(s.id)!),
  }));
}
import { dailyAssessments } from './assessments';
