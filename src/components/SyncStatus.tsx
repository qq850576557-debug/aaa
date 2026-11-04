import { localRecoveryBackup } from '../lib/useEditorJournal';
import { verifiedOwner, pendingRecords } from '../lib/record-outbox';
import { cloudDraftRecoveryPackage } from '../lib/cloud-drafts';
export async function downloadLocalRecovery() {
  const owner = verifiedOwner();
  if (!owner) return;
  const { assessmentDrafts } = await import('../lib/assessment-sync');
  const value = {
    workspace: await cloudDraftRecoveryPackage(owner.workspaceId, owner.id),
    editors: await localRecoveryBackup(),
    records: await pendingRecords(owner),
    assessments: await assessmentDrafts(owner),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = '春茉本地待同步备份.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
