import { localRecoveryBackup } from '../lib/useEditorJournal';
import { verifiedOwner, pendingRecords } from '../lib/record-outbox';
import { cloudDraftRecoveryPackage } from '../lib/cloud-drafts';
import { useEffect, useState } from 'react';
export function SyncStatus({ status }: { status: string }) {
  const [record, setRecord] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const read = (e: Event) => {
      clearTimeout(timer);
      setRecord((e as CustomEvent<string>).detail);
      if ((e as CustomEvent<string>).detail === '云端已保存')
        timer = setTimeout(() => setRecord(''), 5000);
    };
    window.addEventListener('chunmo-outbox-status', read);
    const owner = verifiedOwner();
    if (owner)
      void pendingRecords(owner)
        .then((entries) => {
          if (entries.some((e) => e.blocked)) setRecord('存在待处理数据冲突，本地内容已保留');
          else if (entries.length) setRecord('本地已保存，等待上传');
        })
        .catch(() => setRecord('本地存储读取失败，请保留页面'));
    return () => {
      clearTimeout(timer);
      window.removeEventListener('chunmo-outbox-status', read);
    };
  }, []);
  const backup = async () => {
    try {
      const owner = verifiedOwner();
      if (!owner) return;
      const value = {
        workspace: await cloudDraftRecoveryPackage(owner.workspaceId, owner.id),
        editors: await localRecoveryBackup(),
        records: await pendingRecords(owner),
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = '春茉本地待同步备份.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setRecord('备份失败，请保留当前页面');
    }
  };
  return (
    <small className="sync-status" role="status">
      <button type="button" onClick={() => void backup()}>
        本地备份
      </button>
      {record || ({ 已保存: '云端已保存', 正在保存: '正在保存并上传' }[status] ?? status)}
    </small>
  );
}
