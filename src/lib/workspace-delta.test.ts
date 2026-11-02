import { it, expect } from 'vitest';
import { fixture } from '../../tests/helpers';
import { makeWorkspaceDelta, deltaResources, deltaKey, applyDeltaSide } from './workspace-delta';
it('only encodes changed resources and preserves untouched peer content', () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.projects[0].notes = '单字段修改';
  remote.projects[0].name = '同事改名';
  const proofs = Object.fromEntries(deltaResources(base).map((x) => [deltaKey(x), 'proof']));
  const delta = makeWorkspaceDelta(base, local, 3, 'id', proofs);
  expect(delta.changes).toHaveLength(1);
  expect(delta.changes[0]).toMatchObject({
    collection: 'projects',
    id: base.projects[0].id,
    proof: 'proof',
  });
  expect(JSON.stringify(delta)).not.toContain('t-water');
  const before = applyDeltaSide(remote, delta.changes, 'before'),
    after = applyDeltaSide(remote, delta.changes, 'after');
  expect(before.projects[0].notes).toBe(base.projects[0].notes);
  expect(after.projects[0].notes).toBe('单字段修改');
  expect(after.tasks).toEqual(remote.tasks);
  expect(base.projects[0].notes).not.toBe('单字段修改');
});
it('round trips additions, removals, personnel order and optional metadata without inventing data', () => {
  const base = fixture();
  base.people = [
    { id: 'a', name: '甲', role: '施工人员', active: true, trade: '', notes: '' },
    { id: 'b', name: '乙', role: '施工人员', active: true, trade: '', notes: '' },
  ];
  const local = structuredClone(base);
  local.people!.reverse();
  local.purchases = [];
  local.nameHistory = ['新登记'];
  local.notes.push({ ...local.notes[0], id: 'new-note' });
  const delta = makeWorkspaceDelta(base, local, 0, 'id', {});
  expect(applyDeltaSide(base, delta.changes, 'after')).toEqual(local);
});
