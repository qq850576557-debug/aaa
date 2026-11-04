import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assessmentDrafts,
  retryAssessmentIntent,
  setAssessmentIntent,
  type AssessmentTarget,
} from './assessment-sync';
import { outboxDB, pendingRecords, startRecordSync } from './record-outbox';
import type { Assessment } from './assessments';
afterEach(() => vi.unstubAllGlobals());
const target = (name: string): AssessmentTarget => ({
  date: '2026-11-04',
  personId: name,
  projectId: 'site',
  personName: '师傅',
  projectName: '工地',
  sources: [],
});
function record(t: AssessmentTarget, version = 1): Assessment {
  return {
    ...t,
    id: 'record-' + t.personId,
    tradeId: 'daily',
    version,
    tradeName: '每日打卡',
    attendance: 'pending',
    photo: 'pending',
    cleaning: 'pending',
    createdBy: 'actor',
    createdName: '记录人',
    createdAt: '2026-11-04T00:00:00Z',
    updatedBy: 'actor',
    updatedName: '记录人',
    updatedAt: '2026-11-04T00:00:00Z',
  };
}
it('outbox schema upgrade retains existing pending records and adds only a local assessment draft store', async () => {
  const first = await openDB('chunmo-record-outbox', 1, {
    upgrade(db) {
      db.createObjectStore('pending');
    },
  });
  await first.put(
    'pending',
    {
      owner: { id: 'old', workspaceId: 'old-workspace' },
      path: '/records',
      method: 'POST',
      body: { requestId: 'retained' },
    },
    'old',
  );
  first.close();
  const upgraded = await outboxDB();
  expect(upgraded.version).toBe(2);
  expect((await upgraded.get('pending', 'old')).body.requestId).toBe('retained');
  expect(upgraded.objectStoreNames.contains('assessmentDrafts')).toBe(true);
  upgraded.close();
});
it('rapid offline edits persist separately from one immutable flight and follow its acknowledged version', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'rapid-assessment', workspaceId: 'studio' };
  const t = target('rapid');
  let release!: (v: unknown) => void;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const calls: any[] = [];
  let current = record(t);
  startRecordSync(owner, async (_path, _method, body: any) => {
    calls.push(structuredClone(body));
    expect((await pendingRecords(owner)).some((e) => e.body.requestId === body.requestId)).toBe(
      true,
    );
    if (calls.length === 1) return held;
    current = { ...current, ...body.edits[0].changes, version: body.edits[0].version + 1 };
    return { records: [current] };
  });
  await setAssessmentIntent(t, { attendance: 'pending', photo: 'pending', cleaning: 'pending' });
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const immutable = JSON.stringify(calls[0]);
  await setAssessmentIntent(t, { attendance: 'yes' });
  await setAssessmentIntent(t, { photo: 'no' });
  await setAssessmentIntent(t, { cleaning: 'yes' });
  expect((await assessmentDrafts(owner))[0].fields.photo?.value).toBe('no');
  expect(JSON.stringify((await assessmentDrafts(owner))[0].inFlight?.body)).toBe(immutable);
  release({ records: [current] });
  await vi.waitFor(async () => expect(await assessmentDrafts(owner)).toEqual([]));
  expect(calls).toHaveLength(2);
  expect(calls[1].edits[0].version).toBe(1);
  expect(current).toMatchObject({ attendance: 'yes', photo: 'no', cleaning: 'yes', version: 2 });
  expect(await pendingRecords(owner)).toEqual([]);
});
it('real conflicts retain the original receipt until explicit retry is confirmed and preserve peer fields', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'conflicted-assessment', workspaceId: 'studio' };
  const t = target('conflict');
  t.sources = [record(t)];
  let calls = 0,
    release!: (v: unknown) => void;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let replacement: any;
  startRecordSync(owner, async (_p, _m, body) => {
    if (++calls === 1) throw Object.assign(Error('record changed'), { status: 409 });
    replacement = body;
    return held;
  });
  await setAssessmentIntent(t, { photo: 'yes' });
  await vi.waitFor(async () =>
    expect((await assessmentDrafts(owner))[0].blocked?.status).toBe(409),
  );
  const draft = (await assessmentDrafts(owner))[0];
  const firstId = draft.inFlight!.body.requestId;
  expect((await pendingRecords(owner))[0].body.requestId).toBe(firstId);
  const latest = { ...record(t, 2), attendance: 'no' as const };
  await retryAssessmentIntent(draft, [latest]);
  await vi.waitFor(() => expect(calls).toBe(2));
  expect(await pendingRecords(owner)).toHaveLength(2);
  expect(replacement.requestId).not.toBe(firstId);
  expect(replacement.edits[0]).toMatchObject({ version: 2, changes: { photo: 'yes' } });
  release({ records: [{ ...latest, photo: 'yes', version: 3 }] });
  await vi.waitFor(async () => {
    expect(await assessmentDrafts(owner)).toEqual([]);
    expect(await pendingRecords(owner)).toEqual([]);
  });
  startRecordSync({ id: 'another-account', workspaceId: 'studio' }, async () => {
    throw Error('must not send another account');
  });
  expect(await assessmentDrafts()).toEqual([]);
});
it('a click from a stale new-row render uses the acknowledged creation version, never another v0 create', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'ack-bridge', workspaceId: 'studio' },
    t = target('bridge');
  let version = 0,
    calls = 0;
  startRecordSync(owner, async (_p, _m, body: any) => {
    calls++;
    if (body.edits[0].version !== version)
      throw Object.assign(Error('wrong version'), { status: 409 });
    version++;
    return { records: [{ ...record(t, version), ...body.edits[0].changes }] };
  });
  const next = (e: Event) => {
    if ((e as CustomEvent).detail.records[0].version === 1)
      void setAssessmentIntent(t, { photo: 'yes' });
  };
  window.addEventListener('chunmo-assessment-confirmed', next);
  await setAssessmentIntent(t, { attendance: 'pending', photo: 'pending', cleaning: 'pending' });
  await vi.waitFor(() => expect(calls).toBe(2));
  await vi.waitFor(async () => expect(await assessmentDrafts(owner)).toEqual([]));
  expect(version).toBe(2);
  expect(await pendingRecords(owner)).toEqual([]);
  window.removeEventListener('chunmo-assessment-confirmed', next);
});
