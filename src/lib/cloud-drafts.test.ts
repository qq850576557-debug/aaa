import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  clearCloudDraft,
  readCloudDraft,
  writeCloudDraft,
  recoverCloudDraft,
  cloudDraftRecoveryPackage,
  hasCloudDraftArchive,
  type CloudDraft,
} from './cloud-drafts';
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
it('archives incompatible historical drafts without deleting the original and only exports the current account', async () => {
  const data = emptyData();
  const raw = {
    version: 1,
    accountId: 'archive-owner',
    workspaceId: 'archive-studio',
    tabId: 'original-tab',
    at: new Date().toISOString(),
    base: { data, revision: 0, history: emptyHistory(), baseProof: 'a'.repeat(64) },
    mergeBase: data,
    data: {
      ...data,
      people: [
        {
          id: 'legacy',
          name: '旧草稿师傅',
          role: '施工人员',
          trade: '',
          active: true,
          notes: '',
          obsoleteField: '保留原始内容',
        },
      ],
    },
    inFlight: null,
  };
  await writeCloudDraft(raw as unknown as CloudDraft);
  await writeCloudDraft({
    ...raw,
    accountId: 'other-owner',
    data: { ...data, nameHistory: ['其他账号内容不导出'] },
  } as unknown as CloudDraft);
  expect(
    (await recoverCloudDraft('archive-studio', 'archive-owner', 'original-tab')).archived,
  ).toBe(true);
  expect(await hasCloudDraftArchive('archive-studio', 'archive-owner')).toBe(true);
  const recovery = await cloudDraftRecoveryPackage('archive-studio', 'archive-owner');
  expect(recovery.entries).toHaveLength(2);
  for (const entry of recovery.entries) expect(entry.draft).toEqual(raw);
  expect(JSON.stringify(recovery)).not.toContain('其他账号内容不导出');
  await expect(readCloudDraft('archive-studio', 'archive-owner', 'original-tab')).rejects.toThrow();
});
