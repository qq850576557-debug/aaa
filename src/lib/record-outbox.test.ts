import 'fake-indexeddb/auto';
import { it, expect, vi, afterEach } from 'vitest';
import { durableRecord, pendingRecords, startRecordSync } from './record-outbox';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('persists exact record before transport, retries one receipt and deletes only a confirmed version', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'outbox-a', workspaceId: 'studio' };
  let n = 0;
  const send = vi.fn(async (_p: string, _m: string, b: any) => {
    expect((await pendingRecords(owner))[0].body).toEqual(b);
    if (++n === 1) throw Object.assign(Error('offline'), { status: 0 });
    return { id: 'created-once', version: 1 };
  });
  startRecordSync(owner, send);
  const body = { requestId: crypto.randomUUID(), value: { title: '完整事项' } };
  const promise = durableRecord('/records', 'POST', body);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(await promise).toEqual({ id: 'created-once', version: 1 });
  expect(send).toHaveBeenCalledTimes(2);
  expect(await pendingRecords(owner)).toEqual([]);
});
it('retains a real conflict and isolates accounts rather than overwriting or auto merging it', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'outbox-b', workspaceId: 'studio' };
  startRecordSync(owner, async () => {
    throw Object.assign(Error('conflict'), { status: 409 });
  });
  await expect(
    durableRecord('/records/id', 'PUT', {
      requestId: crypto.randomUUID(),
      version: 1,
      value: { notes: '完整内容' },
    }),
  ).rejects.toThrow('conflict');
  expect((await pendingRecords(owner))[0]).toMatchObject({ blocked: true, body: { version: 1 } });
  expect(await pendingRecords({ ...owner, id: 'other' })).toEqual([]);
});

it('local enqueue returns before cloud response and keeps pending data until the server confirms', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'queued-fast', workspaceId: 'studio' };
  let release: (value: any) => void = () => {};
  const response = new Promise<any>((resolve) => {
    release = resolve;
  });
  startRecordSync(owner, async () => response);
  const { queueRecord } = await import('./record-outbox');
  const queued = await queueRecord('/records', 'POST', {
    requestId: crypto.randomUUID(),
    value: { title: '本地先完成' },
  });
  expect(await pendingRecords(owner)).toHaveLength(1);
  release({ id: 'confirmed', version: 1 });
  await queued.completion;
  expect(await pendingRecords(owner)).toEqual([]);
});
it('overlapping callers for one exact receipt never leave a ghost pending entry after acknowledgement', async () => {
  vi.stubGlobal('window', new EventTarget());
  const owner = { id: 'overlap-receipt', workspaceId: 'studio' };
  startRecordSync(owner, async () => ({ id: 'one-confirmed-record', version: 1 }));
  for (let i = 0; i < 10; i++) {
    const body = { requestId: crypto.randomUUID(), value: { title: '同一次安全重试' } };
    const first = durableRecord('/records', 'POST', body);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([
      first,
      durableRecord('/records', 'POST', body),
      durableRecord('/records', 'POST', body),
    ]);
    expect(await pendingRecords(owner)).toEqual([]);
  }
});
