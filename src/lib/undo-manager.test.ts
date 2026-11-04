import { expect, test } from 'vitest';
import { UndoManager } from './undo-manager';
import { reverseWorkspace } from './workspace-undo';
import { emptyData } from './model';
test('50 effective steps, 51st capacity and exact ordered redo', async () => {
  const history = new UndoManager();
  let value = 0;
  for (let i = 1; i <= 51; i++) {
    value = i;
    history.push({
      label: String(i),
      undo: () => {
        value = i - 1;
      },
      redo: () => {
        value = i;
      },
    });
  }
  expect(history.past).toHaveLength(50);
  for (let i = 0; i < 50; i++) await history.run('undo');
  expect(value).toBe(1);
  expect(history.future).toHaveLength(50);
  for (let i = 0; i < 50; i++) await history.run('redo');
  expect(value).toBe(51);
  expect(history.future).toHaveLength(0);
  await history.run('undo');
  history.push({ label: 'new', undo: () => {}, redo: () => {} });
  expect(history.future).toHaveLength(0);
});
test('text grouping retains inverse sequence; failed undo retains both stacks; scope clears', async () => {
  const history = new UndoManager();
  let value = 0;
  for (let i = 1; i <= 3; i++) {
    value = i;
    history.push({
      label: 'text',
      mergeKey: 'same',
      undo: () => {
        expect(value).toBe(i);
        value = i - 1;
      },
      redo: () => {
        expect(value).toBe(i - 1);
        value = i;
      },
    });
  }
  expect(history.past).toHaveLength(1);
  await history.run('undo');
  expect(value).toBe(0);
  await history.run('redo');
  expect(value).toBe(3);
  history.push({
    label: 'conflict',
    undo: () => {
      throw Error('peer edit');
    },
    redo: () => {},
  });
  await history.run('undo');
  expect(history.past).toHaveLength(2);
  expect(history.future).toHaveLength(0);
  expect(history.message).toContain('peer edit');
  history.reset('other');
  expect(history.past).toHaveLength(0);
});
test('only changed resources reverse, deleted rows recover, changed peer resource conflicts', () => {
  const a = {
    ...emptyData(),
    people: [
      { id: 'a', name: '甲', role: '施工人员' as const, trade: '', notes: 'before', active: true },
    ],
  };
  const b = structuredClone(a);
  b.people[0].notes = 'after';
  const current = structuredClone(b);
  current.recentColors = ['#123456'];
  expect(reverseWorkspace(b, a, current).people![0].notes).toBe('before');
  expect(reverseWorkspace(b, a, current).recentColors).toEqual(['#123456']);
  current.people[0].notes = 'peer';
  expect(() => reverseWorkspace(b, a, current)).toThrow('新修改');
  const deleted = { ...a, people: [] };
  expect(reverseWorkspace(deleted, a, deleted).people).toEqual(a.people);
});
test('async replay cannot record itself; legitimate new edits during upload form a new branch', async () => {
  const h = new UndoManager();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.push({ label: 'a', undo: () => gate, redo: () => {} });
  const work = h.run('undo');
  h.withoutCapture(() => h.push({ label: 'inverse', undo: () => {}, redo: () => {} }));
  h.push({ label: 'other edit', undo: () => {}, redo: () => {} });
  release();
  await work;
  expect(h.past.map((c) => c.label)).toEqual(['other edit']);
  expect(h.future).toHaveLength(0);
});

test('workspace text coalescing submits one inverse without intermediate writes', async () => {
  const { businessUndo } = await import('./undo-manager');
  const { rememberWorkspace } = await import('./workspace-undo');
  const documentBefore = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement: { matches: () => true } },
  });
  try {
    businessUndo.reset('group-test');
    let current = {
      ...emptyData(),
      people: [
        { id: 'a', name: '甲', role: '施工人员' as const, trade: '', notes: '', active: true },
      ],
    };
    let writes = 0;
    for (let i = 1; i <= 3; i++) {
      const before = structuredClone(current);
      current.people[0].notes = '文字' + i;
      rememberWorkspace(
        before,
        structuredClone(current),
        () => current,
        (d) => {
          current = d as typeof current;
          writes++;
        },
      );
    }
    expect(businessUndo.past).toHaveLength(1);
    await businessUndo.run('undo');
    expect(current.people[0].notes).toBe('');
    expect(writes).toBe(1);
    await businessUndo.run('redo');
    expect(current.people[0].notes).toBe('文字3');
    expect(writes).toBe(2);
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentBefore });
    businessUndo.reset();
  }
});

test('an asynchronous old operation cannot re-enter history after a same-account version reset', async () => {
  const h = new UndoManager();
  let finish!: () => void;
  h.push({ label: 'old', undo: () => new Promise<void>((r) => (finish = r)), redo: () => {} });
  const operation = h.run('undo');
  h.reset();
  finish();
  await operation;
  expect(h.past).toHaveLength(0);
  expect(h.future).toHaveLength(0);
});

test('resolving differing legacy sources remains undoable when the first source already has the selected value', async () => {
  const { businessUndo } = await import('./undo-manager');
  const { rememberAssessment } = await import('./assessment-undo');
  const row = {
    id: 'a',
    date: '2026-11-04',
    personId: 'p',
    projectId: 'site',
    tradeId: 'old-a',
    personName: '师傅',
    projectName: '工地',
    tradeName: '工种',
    version: 1,
    attendance: 'yes' as const,
    photo: 'pending' as const,
    cleaning: 'pending' as const,
    createdBy: 'actor',
    createdName: '记录人',
    createdAt: '2026-11-04T00:00:00Z',
    updatedBy: 'actor',
    updatedName: '记录人',
    updatedAt: '2026-11-04T00:00:00Z',
  };
  businessUndo.reset();
  rememberAssessment(
    {
      date: row.date,
      personId: 'p',
      projectId: 'site',
      personName: '师傅',
      projectName: '工地',
      sources: [row, { ...row, id: 'b', tradeId: 'old-b', attendance: 'no' }],
    },
    { attendance: 'yes' },
    { attendance: 'yes' },
  );
  expect(businessUndo.past).toHaveLength(1);
  businessUndo.reset();
});

test('a rejected inverse can be explicitly abandoned without executing a data mutation', async () => {
  const h = new UndoManager();
  let abandon = 0;
  h.push({
    label: 'conflict',
    undo: () => {
      throw Error('peer');
    },
    redo: () => {},
    discard: async () => {
      abandon++;
    },
  });
  await h.run('undo');
  expect(h.canDiscard).toBe(true);
  await h.discardFailed();
  expect(abandon).toBe(1);
  expect(h.past).toHaveLength(0);
  expect(h.future).toHaveLength(0);
});
