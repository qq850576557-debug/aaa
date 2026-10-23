import { describe, expect, it } from 'vitest';
import {
  emptyData,
  newProject,
  defaultTrades,
  parseBackup,
  reorderProjects,
  rememberNames,
  copyProject,
  type Personnel,
  type Task,
} from './model';
import { proposeTaskChange } from './scheduling';

const people: Personnel = { worker: '李师傅', manager: '王经理', designer: '陈设计' };
function workspace() {
  const d = emptyData();
  d.projects = ['甲', '乙', '丙'].map((name) => ({ ...newProject(), name }));
  d.trades = defaultTrades(d.projects[0].id);
  return d;
}
describe('phase 3: compatible workspace changes', () => {
  it('accepts legacy data byte-for-byte at the object level without database migration', () => {
    const d = workspace();
    expect(parseBackup(d)).toEqual(d);
    expect(parseBackup(d).nameHistory).toBeUndefined();
  });
  it('round trips personnel, removed history candidates, and project order in JSON backups', () => {
    const d = workspace();
    d.projects[0].personnel = people;
    d.trades[0].personnel = people;
    const updated = { ...d, nameHistory: [] };
    expect(parseBackup(JSON.parse(JSON.stringify(updated)))).toEqual(updated);
    expect(copyProject(updated, d.projects[0]).project.personnel).toEqual(people);
  });
  it('reorders visible projects and leaves completed projects and linked data intact', () => {
    const d = workspace();
    d.projects[1].status = '已完工';
    const [a, b, c] = d.projects;
    const next = reorderProjects(d, c.id, a.id, [a.id, c.id]);
    expect(next.projects.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(next.trades).toEqual(d.trades);
    expect(next.projects.find((p) => p.id === b.id)).toEqual(b);
    expect(parseBackup(next)).toEqual(next);
    expect(reorderProjects(d, a.id, a.id, [a.id, c.id])).toBe(d);
  });
  it('records new personnel names, respects deletion, and never deletes existing registrations', () => {
    const d = workspace();
    d.projects[0].personnel = people;
    const remembered = rememberNames(d, people);
    expect(remembered.nameHistory).toEqual(Object.values(people));
    const removed = {
      ...remembered,
      nameHistory: remembered.nameHistory!.filter((n) => n !== people.worker),
    };
    const untouched = rememberNames(removed, people, people);
    expect(untouched.nameHistory).not.toContain(people.worker);
    expect(untouched.projects[0].personnel).toEqual(people);
    expect(rememberNames(untouched, { ...people, worker: '新师傅' }, people).nameHistory).toContain(
      '新师傅',
    );
  });
  it('rejects invalid personnel without accepting partial backup data', () => {
    const d = workspace();
    d.projects[0].personnel = { ...people, worker: '字'.repeat(4001) };
    expect(() => parseBackup(d)).toThrow();
  });
  it('proposes downstream delay for a newly created task while keeping the original snapshot intact', () => {
    const d = workspace();
    const pid = d.projects[0].id;
    const task: Task = {
      id: 'later',
      projectId: pid,
      tradeId: d.trades[1].id,
      name: '水电',
      start: '2026-10-25',
      end: '2026-10-28',
      status: '未开始',
      owner: '',
      notes: '',
    };
    d.tasks = [task];
    const plan = proposeTaskChange(d, {
      ...task,
      id: 'new',
      tradeId: d.trades[0].id,
      start: '2026-10-24',
      end: '2026-10-26',
    });
    expect(plan.affected).toHaveLength(1);
    expect(plan.shifted.tasks.find((t) => t.id === 'later')?.start).toBe('2026-10-27');
    expect(plan.current.tasks.find((t) => t.id === 'later')).toEqual(task);
    expect(d.tasks).toEqual([task]);
  });
});

it('keeps valid long legacy personnel values without truncating project records', () => {
  const d = workspace();
  const legacy = '王'.repeat(200);
  d.projects[0].manager = legacy;
  d.projects[0].personnel = { worker: '', manager: legacy, designer: '新设计' };
  const next = rememberNames(d, d.projects[0].personnel);
  expect(parseBackup(next).projects[0].manager).toBe(legacy);
  expect(parseBackup(next).projects[0].personnel?.manager).toBe(legacy);
  expect(next.nameHistory).toContain('新设计');
  expect(next.nameHistory).not.toContain(legacy);
});
