import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { clearCloudDraft, readCloudDraft, writeCloudDraft, type CloudDraft } from './cloud-drafts';
import { emptyData, newProject } from './model';
import { emptyHistory } from './history';
describe('isolated durable cloud draft journal', () => {
  it('retains full draft, signed base and exact ambiguous request without writing the local business DB', async () => {
    const base = emptyData(),
      local = emptyData();
    local.projects = [{ ...newProject(), name: '未提交草稿' }];
    const draft: CloudDraft = {
      version: 1,
      accountId: 'employee',
      workspaceId: 'studio',
      tabId: 'tab',
      at: new Date().toISOString(),
      base: { data: base, revision: 1, history: emptyHistory(), baseProof: 'a'.repeat(64) },
      mergeBase: base,
      data: local,
      inFlight: {
        view: local,
        body: {
          revision: 1,
          baseProof: 'a'.repeat(64),
          base,
          data: local,
          requestId: crypto.randomUUID(),
        },
      },
    };
    await writeCloudDraft(draft);
    expect(await readCloudDraft('studio', 'employee', 'tab')).toEqual(draft);
    expect(await readCloudDraft('studio', 'owner', 'tab')).toBeUndefined();
    expect(await readCloudDraft('other', 'employee', 'tab')).toBeUndefined();
    expect(await readCloudDraft('studio', 'employee', 'other-tab')).toBeUndefined();
    expect((await indexedDB.databases()).some((db) => db.name === 'chunmo-workspace')).toBe(false);
    await clearCloudDraft('studio', 'employee', 'other-tab');
    expect(await readCloudDraft('studio', 'employee', 'tab')).toEqual(draft);
    await clearCloudDraft('studio', 'employee', 'tab');
    expect(await readCloudDraft('studio', 'employee', 'tab')).toBeUndefined();
  });
});
