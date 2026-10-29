import { describe, expect, it } from 'vitest';
import { emptyData, type Note } from './model';
import { projectAgenda } from './agenda';
const n = (id: string, date: string, patch: Partial<Note> = {}): Note => ({
  id,
  projectId: 'a',
  title: id,
  kind: '施工安排',
  date,
  reminder: '',
  owner: '',
  content: '',
  done: false,
  pinned: false,
  ...patch,
});
describe('date-based project agenda', () => {
  it('retains memo pin priority even when a pinned memo was marked complete', () => {
    const d = emptyData();
    d.notes = [
      n('ordinary', '', { kind: '项目备忘' }),
      n('pinned-done', '', { kind: '项目备忘', done: true, pinned: true }),
      n('last', '', { kind: '项目备忘' }),
    ];
    expect(projectAgenda(d, 'a', '2026-10-29').memos.map((n) => n.id)).toEqual([
      'pinned-done',
      'ordinary',
      'last',
    ]);
  });
  it('separates today/tomorrow/memos and other projects without changing original records', () => {
    const d = emptyData();
    d.notes = [
      n('late', '2026-10-28'),
      n('today', '2026-10-29'),
      n('tomorrow', '2026-10-30'),
      n('future', '2026-11-01'),
      n('memo', '2026-10-29', { kind: '项目备忘' }),
      n('other', '2026-10-30', { projectId: 'b' }),
      n('finished-old', '2026-10-28', { done: true }),
    ];
    const original = structuredClone(d),
      a = projectAgenda(d, 'a', '2026-10-29');
    expect(a.today.map((n) => n.id)).toEqual(['late', 'today']);
    expect(a.tomorrow.map((n) => n.id)).toEqual(['tomorrow']);
    expect(a.memos.map((n) => n.id)).toEqual(['memo']);
    expect(d).toEqual(original);
    expect(new Set([...a.today, ...a.tomorrow, ...a.memos].map((n) => n.id)).size).toBe(4);
  });
  it('year-end and leap-day rollover reuse IDs; completed notes remain saved', () => {
    const d = emptyData();
    d.notes = [n('pending', '2027-01-01'), n('finished', '2027-01-01', { done: true })];
    const before = projectAgenda(d, 'a', '2026-12-31'),
      after = projectAgenda(d, 'a', '2027-01-01');
    expect(before.tomorrowDate).toBe('2027-01-01');
    expect(after.today.map((n) => n.id)).toEqual(before.tomorrow.map((n) => n.id));
    expect(after.tomorrow).toHaveLength(0);
    expect(projectAgenda(d, 'a', '2027-01-02').today.map((n) => n.id)).toEqual(['pending']);
    expect(d.notes).toHaveLength(2);
    expect(projectAgenda(d, 'a', '2028-02-28').tomorrowDate).toBe('2028-02-29');
    expect(projectAgenda(d, 'a', '2028-02-29').tomorrowDate).toBe('2028-03-01');
  });
  it('editing dates, completing and deleting use the single saved note source; purchases never become agenda entries', () => {
    const d = emptyData();
    d.notes = [n('one', '2026-10-30')];
    const edited = { ...d, notes: d.notes.map((n) => ({ ...n, date: '2026-10-29', done: true })) };
    expect(projectAgenda(edited, 'a', '2026-10-29').tomorrow).toHaveLength(0);
    expect(projectAgenda(edited, 'a', '2026-10-29').today[0]).toMatchObject({
      id: 'one',
      done: true,
    });
    expect(projectAgenda({ ...d, notes: [] }, 'a', '2026-10-29').tomorrow).toHaveLength(0);
    expect(projectAgenda(d, undefined, '2026-10-29').tomorrow).toHaveLength(0);
  });
});
