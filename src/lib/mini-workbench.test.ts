import { test, expect } from 'vitest';
import { fixture } from '../../tests/helpers';
import { planPurchase, workbenchView, shanghaiDay } from './mini-workbench';
import { purchaseDue } from './model';
test('Mini planner edits just one purchase and preserves linked dates and unrelated resources', () => {
  const data = fixture();
  const p = data.purchases[0];
  const state = {
    data,
    revision: 7,
    resourceProofs: { [JSON.stringify(['purchases', 'record', p.id])]: 'proof' },
  };
  const plan = planPurchase(state, { status: '已下单' }, crypto.randomUUID(), p.id);
  expect(plan.changes).toHaveLength(1);
  expect(plan.changes[0]).toMatchObject({
    collection: 'purchases',
    kind: 'record',
    id: p.id,
    proof: 'proof',
  });
  expect(plan.changes[0].before).toEqual(p);
  expect(purchaseDue(plan.changes[0].after as typeof p, data)).toBe(purchaseDue(p, data));
  expect(data.purchases[0]).toEqual(p);
});
test('Shanghai day and existing completed/arrived semantics remain shared', () => {
  expect(shanghaiDay(Date.parse('2026-11-13T16:00:00Z'))).toBe('2026-11-14');
  const data = fixture();
  data.purchases = data.purchases.map((p) => ({ ...p, status: '已到货' }));
  const v = workbenchView(data, [], { id: 'test', name: 'test' }, '2026-11-13');
  expect(v.items.every((x) => x.done)).toBe(true);
  expect(v.overdue).toHaveLength(0);
});
