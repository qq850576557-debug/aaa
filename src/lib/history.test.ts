import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { emptyData, newProject, defaultTrades, parseBackup, type Data } from './model';
import {
  canonical,
  emptyHistory,
  recordChanges,
  restoreBefore,
  retainHistory,
  RETENTION,
  validateHistory,
  GLOBAL_SCOPE,
} from './history';
import { loadData, loadHistory, saveData, restoreRevision, pruneHistory } from './storage';
import 'fake-indexeddb/auto';
const now = Date.parse('2026-10-23T04:00:00Z');
function fixture(): Data {
  const a = { ...newProject(), id: 'a', name: '甲项目' },
    b = { ...newProject(), id: 'b', name: '乙项目' };
  const trades = defaultTrades('a');
  return {
    ...emptyData(),
    projects: [a, b],
    trades,
    tasks: [
      {
        id: 't',
        projectId: 'a',
        tradeId: trades[0].id,
        name: '拆改',
        start: '2026-10-25',
        end: '2026-10-26',
        owner: '',
        status: '未开始',
        notes: '',
      },
    ],
    purchases: [
      {
        id: 'buy',
        projectId: 'a',
        name: '材料',
        due: '2026-10-25',
        originalDue: '2026-10-25',
        deadlineMode: 'fixed',
        taskId: 't',
        leadDays: 0,
        owner: '',
        notes: '',
        status: '待采购',
      },
    ],
  };
}
beforeEach(() => {
  vi.useRealTimers();
  globalThis.indexedDB = new IDBFactory();
});
describe('complete 15-day project versions', () => {
  it('has no invented history for legacy reads and ignores timestamp-only/no-op saves', async () => {
    const d = fixture();
    const conn = await openDB('chunmo-workspace', 1, {
      upgrade(db) {
        db.createObjectStore('workspace');
      },
    });
    await conn.put('workspace', d, 'data');
    conn.close();
    expect(await loadData()).toEqual(d);
    expect((await loadHistory()).records).toEqual([]);
    const next = structuredClone(d);
    next.projects[0].updatedAt = new Date().toISOString();
    const result = await saveData(next, d);
    expect(result.history.records).toEqual([]);
    expect(result.data.projects[0].updatedAt).toBe(d.projects[0].updatedAt);
  });
  it('stores complete scoped snapshots and readable before/after task/purchase values', () => {
    const d = fixture(),
      next = structuredClone(d);
    next.tasks[0].start = '2026-10-24';
    next.purchases[0].due = '2026-10-23';
    const result = recordChanges(d, next, emptyHistory(), now);
    expect(result.history.records).toHaveLength(1);
    const record = result.history.records[0];
    expect(record.actor).toBe('本地操作记录');
    expect(record.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '拆改 · 开始日期',
          before: '2026-10-25',
          after: '2026-10-24',
        }),
        expect.objectContaining({ label: '材料 · 采购截止日期', after: '2026-10-23' }),
      ]),
    );
    expect(restoreBefore(result.data, result.history, record.id, now).tasks).toEqual(d.tasks);
  });
  it('restores an arbitrary earlier version and preserves later history and every other project', async () => {
    const d = fixture(),
      first = await saveData(d);
    const n1 = structuredClone(first.data);
    n1.projects[0].name = '改名';
    const second = await saveData(n1, first.data);
    const n2 = structuredClone(second.data);
    n2.tasks = [];
    n2.purchases[0].taskId = '';
    n2.projects[1].notes = '乙的独立变更';
    const third = await saveData(n2, second.data);
    const target = second.history.records.find((r) => r.scope === 'a' && r.action === '修改')!;
    const restored = await restoreRevision(third.data, target.id);
    expect(restored.data.projects[0].name).toBe('甲项目');
    expect(restored.data.tasks).toEqual(d.tasks);
    expect(restored.data.purchases[0].taskId).toBe('t');
    expect(restored.data.projects[1]).toEqual(third.data.projects[1]);
    expect(restored.history.records.map((r) => r.id)).toEqual(
      expect.arrayContaining(third.history.records.map((r) => r.id)),
    );
    const restore = restored.history.records.at(-1)!;
    expect(restore.action).toBe('恢复');
    expect(restore.source).toBe(target.id);
    const again = await restoreRevision(restored.data, restore.id);
    expect(again.data.projects[0].name).toBe('改名');
    expect(again.data.tasks).toEqual([]);
    expect((await loadHistory()).records).toHaveLength(again.history.records.length);
  });
  it('recovers a deleted project graph without changing the other project', () => {
    const d = fixture(),
      next = { ...d, projects: [d.projects[1]], tasks: [], trades: [], purchases: [] };
    const saved = recordChanges(d, next, emptyHistory(), now);
    const deletion = saved.history.records.find((r) => r.scope === 'a')!;
    expect(deletion.action).toBe('删除');
    const restored = restoreBefore(saved.data, saved.history, deletion.id, now);
    expect(restored.tasks).toEqual(d.tasks);
    expect(restored.trades).toEqual(d.trades);
    expect(restored.projects.find((p) => p.id === 'b')).toEqual(d.projects[1]);
  });
  it('prunes expired versions and unreferenced snapshots, includes exact 15-day boundary and refuses expired restore', () => {
    const d = fixture(),
      next = structuredClone(d);
    next.projects[0].name = '改名';
    const r = recordChanges(d, next, emptyHistory(), now);
    expect(retainHistory(r.history, now + RETENTION).records).toHaveLength(1);
    expect(
      restoreBefore(r.data, r.history, r.history.records[0].id, now + RETENTION).projects[0].name,
    ).toBe('甲项目');
    const expired = retainHistory(r.history, now + RETENTION + 1);
    expect(expired.records).toEqual([]);
    expect(expired.snapshots).toEqual({});
    expect(() =>
      restoreBefore(r.data, r.history, r.history.records[0].id, now + RETENTION + 1),
    ).toThrow('15天');
    expect(r.data.projects[0].name).toBe('改名');
  });
  it('deduplicates consecutive snapshots while retaining independently restorable complete data', () => {
    const d = fixture(),
      a = structuredClone(d);
    a.projects[0].notes = '一';
    const first = recordChanges(d, a, emptyHistory(), now);
    const b = structuredClone(first.data);
    b.projects[0].notes = '二';
    const second = recordChanges(first.data, b, first.history, now + 1000);
    expect(second.history.records[0].after).toBe(second.history.records[1].before);
    expect(Object.keys(second.history.snapshots)).toHaveLength(3);
    expect(
      restoreBefore(b, second.history, second.history.records[0].id, now + 2000).projects[0].notes,
    ).toBe('');
  });
  it('keeps private global registry history separate and rejects a restore with missing required staff atomically', async () => {
    const d = fixture();
    d.people = [
      { id: 'staff', name: '陈设计', role: '设计人员', trade: '', notes: '登记备注', active: true },
    ];
    d.projects[0].staffIds = ['staff'];
    const first = await saveData(d);
    const change = structuredClone(first.data);
    change.projects[0].staffIds = [];
    const second = await saveData(change, first.data);
    const last = structuredClone(second.data);
    last.people = [];
    const third = await saveData(last, second.data);
    const target = second.history.records.find((r) => r.scope === 'a' && r.action === '修改')!;
    await expect(restoreRevision(third.data, target.id)).rejects.toThrow('人员关联');
    expect(await loadData()).toEqual(third.data);
    expect(await loadHistory()).toEqual(third.history);
    const project = third.history.records.filter((r) => r.scope === 'a');
    expect(project.some((r) => r.changes.some((c) => c.module === '人员档案'))).toBe(false);
    expect(
      third.history.records.some(
        (r) => r.scope === GLOBAL_SCOPE && r.changes.some((c) => c.module === '人员档案'),
      ),
    ).toBe(true);
  });
  it('rejects broken/cross-project snapshots and preserves all current data on restore failure', async () => {
    const first = await saveData(fixture());
    const conn = await openDB('chunmo-workspace', 1);
    const bad = structuredClone(first.history);
    delete bad.snapshots[bad.records[0].before];
    await conn.put('workspace', bad, 'history');
    conn.close();
    await expect(restoreRevision(first.data, first.history.records[0].id)).rejects.toThrow('快照');
    expect(await loadData()).toEqual(first.data);
    const broken = structuredClone(first.history);
    const r = broken.records.find((r) => r.scope === 'a')!;
    r.scope = 'wrong';
    expect(() => validateHistory(broken)).toThrow();
  });
  it('detects another tab before overwriting business data or versions', async () => {
    const one = await saveData(fixture());
    const changed = structuredClone(one.data);
    changed.projects[0].name = '标签页二';
    const two = await saveData(changed, one.data);
    const stale = structuredClone(one.data);
    stale.projects[0].notes = '过期的标签页一';
    await expect(saveData(stale, one.data)).rejects.toThrow('其他标签页');
    expect(await loadData()).toEqual(two.data);
    expect(await loadHistory()).toEqual(two.history);
  });
  it('aborts both writes if the history write fails and keeps the former business state', async () => {
    const one = await saveData(fixture());
    const conn = await openDB('chunmo-workspace', 1);
    const tx = conn.transaction('workspace', 'readwrite');
    await tx.objectStore('workspace').put(one.history, 'history');
    await tx.done;
    conn.close();
    const proto = IDBObjectStore.prototype,
      put = proto.put;
    const spy = vi.spyOn(proto, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (key === 'history') throw new DOMException('quota', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    const next = structuredClone(one.data);
    next.projects[0].name = '不得落盘';
    await expect(saveData(next, one.data)).rejects.toThrow('quota');
    spy.mockRestore();
    expect(await loadData()).toEqual(one.data);
    expect(await loadHistory()).toEqual(one.history);
  });
  it('cleanup failure does not alter current business data and optional model extensions round trip', async () => {
    const one = await saveData(fixture());
    expect(parseBackup(JSON.parse(JSON.stringify(one.data)))).toEqual(one.data);
    await pruneHistory(Date.now() + RETENTION + 1000);
    expect((await loadHistory()).records).toEqual([]);
    expect(canonical(await loadData())).toBe(canonical(one.data));
  });
});

it('version archive round trips, merges without erasing later history and rejects conflicting snapshots', async () => {
  const { mergeHistory, parseArchive } = await import('./history');
  const one = await saveData(fixture());
  const archive = parseArchive(
    JSON.parse(
      JSON.stringify({
        format: 'chunmo-history-backup',
        version: 1,
        data: one.data,
        history: one.history,
      }),
    ),
  );
  expect(archive.data).toEqual(one.data);
  expect(archive.history).toEqual(one.history);
  const next = structuredClone(one.data);
  next.projects[0].name = '后续';
  const two = await saveData(next, one.data);
  const combined = mergeHistory(two.history, archive.history!);
  expect(combined.records.map((r) => r.id)).toEqual(
    expect.arrayContaining(two.history.records.map((r) => r.id)),
  );
  const bad = structuredClone(one.history),
    r = bad.records.find((r) => r.scope === 'a')!,
    snap = bad.snapshots[r.after];
  if (snap.kind === 'project') snap.data.projects[0].name = '伪造冲突';
  expect(() => mergeHistory(two.history, bad)).toThrow('冲突');
  const restored = await saveData(archive.data, two.data, {
    history: archive.history,
    source: 'JSON备份恢复',
  });
  expect(restored.history.records.at(-1)?.action).toBe('恢复');
  expect(restored.history.records.map((r) => r.id)).toEqual(
    expect.arrayContaining(two.history.records.map((r) => r.id)),
  );
});
it('rejects collection of private profile fields and duplicate project staff references', () => {
  const d = fixture();
  d.people = [
    { id: 'staff', name: '工人', role: '施工人员', trade: '拆改', notes: '', active: true },
  ];
  d.projects[0].staffIds = ['staff'];
  expect(parseBackup(d).people).toEqual(d.people);
  expect(() =>
    parseBackup({ ...d, people: [{ ...d.people![0], phone: '13800000000' }] }),
  ).toThrow();
  expect(() =>
    parseBackup({ ...d, people: [{ ...d.people![0], birthDate: '1990-01-01' }] }),
  ).toThrow();
  d.projects[0].staffIds = ['staff', 'staff'];
  expect(() => parseBackup(d)).toThrow('人员关联');
});
it('a failed expired-version cleanup leaves both the business graph and history unchanged', async () => {
  const one = await saveData(fixture());
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (key === 'history') throw new DOMException('清理失败', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  await expect(pruneHistory(Date.now() + RETENTION + 1)).rejects.toThrow('清理失败');
  spy.mockRestore();
  expect(await loadData()).toEqual(one.data);
  expect(await loadHistory()).toEqual(one.history);
});

it('classifies child deletion and staff deactivation/deletion truthfully rather than every project change as 修改', async () => {
  const { changeAction } = await import('./history');
  const d = fixture(),
    next = structuredClone(d);
  next.tasks = [];
  next.purchases[0].taskId = '';
  const result = recordChanges(d, next, emptyHistory(), now);
  expect(result.history.records[0].action).toBe('删除');
  expect(
    changeAction([
      { module: '人员档案', label: '陈设计 · 删除标记', before: '未设置', after: 'true' },
    ]),
  ).toBe('删除');
  expect(
    changeAction([
      { module: '人员档案', label: '陈设计 · 启用状态', before: 'true', after: 'false' },
    ]),
  ).toBe('修改');
});

it('rejects inherited-object names as missing snapshot references instead of accepting incomplete version data', () => {
  const d = fixture(),
    next = structuredClone(d);
  next.projects[0].name = '改名';
  const h = recordChanges(d, next, emptyHistory(), now).history;
  for (const key of ['toString', 'constructor', '__proto__']) {
    const invalid = structuredClone(h);
    invalid.records[0].before = key;
    expect(() => validateHistory(invalid)).toThrow('快照');
  }
});
