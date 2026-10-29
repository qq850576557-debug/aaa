import { openDB } from 'idb';
import type { CloudState } from './cloud';
import { parseBackup, type Data } from './model';
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
    return d;
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
