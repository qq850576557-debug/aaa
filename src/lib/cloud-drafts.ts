import { openDB } from 'idb';
import type { CloudState } from './cloud';
import { parseBackup, type Data } from './model';
import type { SaveHold } from './workspace-save-plan';
export type WorkspaceSubmission = Pick<CloudState, 'revision' | 'baseProof'> & {
  base: Data;
  data: Data;
  requestId: string;
};
export type CloudDraft = {
  version: 1;
  accountId: string;
  workspaceId: string;
  tabId: string;
  at: string;
  base: CloudState;
  mergeBase: Data;
  data: Data;
  inFlight: { body: WorkspaceSubmission; view: Data } | null;
  holds?: SaveHold[];
};
// A separate browser journal. Never opens or writes the original local business database.
const database = () =>
  openDB('chunmo-cloud-drafts', 1, {
    upgrade(db) {
      db.createObjectStore('drafts');
    },
  });
export function draftTab() {
  const key = 'chunmo-cloud-draft-tab';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}
export async function claimDraftTab() {
  let id = draftTab();
  if (!navigator.locks) return { id, release: () => {} };
  for (;;) {
    let release = () => {};
    const claimed = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks
        .request('chunmo-cloud-draft:' + id, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          const hold = new Promise<void>((r) => {
            release = r;
          });
          resolve(true);
          await hold;
        })
        .catch(reject);
    });
    if (claimed) return { id, release };
    // A duplicated tab can inherit sessionStorage. It must never overwrite the live tab's journal.
    id = crypto.randomUUID();
    sessionStorage.setItem('chunmo-cloud-draft-tab', id);
  }
}
export const draftKey = (workspaceId: string, accountId: string, tabId: string) =>
  JSON.stringify([workspaceId, accountId, tabId]);
export async function readCloudDraft(workspaceId: string, accountId: string, tabId: string) {
  const db = await database();
  try {
    const d: CloudDraft | undefined = await db.get(
      'drafts',
      draftKey(workspaceId, accountId, tabId),
    );
    if (!d) return;
    if (
      d.version !== 1 ||
      d.workspaceId !== workspaceId ||
      d.accountId !== accountId ||
      d.tabId !== tabId
    )
      throw Error('浏览器草稿归属无效；原草稿保留，未自动载入');
    parseBackup(d.base.data);
    parseBackup(d.mergeBase);
    parseBackup(d.data);
    if (d.inFlight) {
      parseBackup(d.inFlight.body.base);
      parseBackup(d.inFlight.body.data);
      parseBackup(d.inFlight.view);
    }
    if (
      d.holds &&
      (!Array.isArray(d.holds) ||
        d.holds.some(
          (x) =>
            !x ||
            !['validation', 'conflict', 'dependency'].includes(x.kind) ||
            ![
              'projects',
              'trades',
              'tasks',
              'notes',
              'purchases',
              'people',
              'dictionaries',
              'workspace',
            ].includes(x.collection) ||
            typeof x.id !== 'string' ||
            typeof x.reason !== 'string',
        ))
    )
      throw Error('草稿的待处理记录标记无效；原草稿保留');
    return d;
  } finally {
    db.close();
  }
}
export async function recoverCloudDraft(workspaceId: string, accountId: string, tabId: string) {
  try {
    return { draft: await readCloudDraft(workspaceId, accountId, tabId), archived: false };
  } catch (error) {
    const db = await database();
    try {
      const raw = await db.get('drafts', draftKey(workspaceId, accountId, tabId));
      if (
        !raw ||
        raw.workspaceId !== workspaceId ||
        raw.accountId !== accountId ||
        raw.tabId !== tabId
      )
        throw error;
      // Keep the original slot too. A fresh tab slot is claimed before any new journal write.
      await db.put(
        'drafts',
        raw,
        JSON.stringify(['archive', workspaceId, accountId, tabId, crypto.randomUUID()]),
      );
      return { draft: undefined, archived: true };
    } finally {
      db.close();
    }
  }
}
export async function cloudDraftRecoveryPackage(workspaceId: string, accountId: string) {
  const db = await database();
  try {
    const tx = db.transaction('drafts'),
      entries = [];
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const value = cursor.value;
      if (value?.workspaceId === workspaceId && value?.accountId === accountId)
        entries.push({ key: cursor.key, draft: value });
      cursor = await cursor.continue();
    }
    await tx.done;
    return { format: 'chunmo-cloud-draft-recovery', version: 1, workspaceId, accountId, entries };
  } finally {
    db.close();
  }
}
export async function hasCloudDraftArchive(workspaceId: string, accountId: string) {
  const db = await database();
  try {
    return (await db.getAllKeys('drafts')).some((key) => {
      if (typeof key !== 'string') return false;
      try {
        const parts = JSON.parse(key);
        return parts[0] === 'archive' && parts[1] === workspaceId && parts[2] === accountId;
      } catch {
        return false;
      }
    });
  } finally {
    db.close();
  }
}
export async function retainCloudDraftSnapshot(
  workspaceId: string,
  accountId: string,
  tabId: string,
) {
  const db = await database();
  try {
    const raw = await db.get('drafts', draftKey(workspaceId, accountId, tabId));
    if (
      !raw ||
      raw.workspaceId !== workspaceId ||
      raw.accountId !== accountId ||
      raw.tabId !== tabId
    )
      throw Error('无法确认原草稿备份，未应用恢复选择');
    await db.put(
      'drafts',
      raw,
      JSON.stringify(['recovery', workspaceId, accountId, tabId, crypto.randomUUID()]),
    );
  } finally {
    db.close();
  }
}
export async function writeCloudDraft(draft: CloudDraft) {
  const db = await database();
  try {
    await db.put('drafts', draft, draftKey(draft.workspaceId, draft.accountId, draft.tabId));
  } finally {
    db.close();
  }
}
export async function clearCloudDraft(workspaceId: string, accountId: string, tabId: string) {
  const db = await database();
  try {
    await db.delete('drafts', draftKey(workspaceId, accountId, tabId));
  } finally {
    db.close();
  }
}
