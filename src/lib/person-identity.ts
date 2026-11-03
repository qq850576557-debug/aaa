import type { Person } from './model';
const text = (value: string | undefined) =>
  (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
// A guard for new submissions, never a merger or an automatic historical cleanup.
export const personProfile = (p: Person) =>
  JSON.stringify([
    text(p.name),
    p.role,
    text(p.trade),
    p.categoryId ?? '',
    [...new Set(p.tradeIds ?? [])].sort(),
    text(p.notes),
  ]);
export const duplicatePerson = (people: Person[], incoming: Person) => {
  const profile = personProfile(incoming);
  return people.find((p) => p.id !== incoming.id && personProfile(p) === profile);
};
