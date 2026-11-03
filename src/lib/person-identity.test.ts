import { it, expect } from 'vitest';
import { duplicatePerson } from './person-identity';
import type { Person } from './model';
const p: Person = {
  id: 'one',
  name: ' 张师傅 ',
  role: '施工人员',
  trade: '木工',
  notes: '',
  active: true,
};
it('new duplicate profiles are caught across ids, including deleted history, without merging same-name different people', () => {
  expect(duplicatePerson([p], { ...p, id: 'two', name: '张师傅' })).toBe(p);
  expect(
    duplicatePerson([{ ...p, deleted: true, active: false }], { ...p, id: 'two' }),
  ).toBeDefined();
  expect(duplicatePerson([p], { ...p, id: 'two', notes: '同名的另一位师傅' })).toBeUndefined();
  expect(duplicatePerson([p], p)).toBeUndefined();
  expect(p.name).toBe(' 张师傅 ');
});
