import { useState } from 'react';
import { Modal } from './Modal';
import { backupJSON } from '../lib/export';
import type { SaveConflict } from '../lib/useCloudWorkspace';
import type { MergeChoices } from '../lib/workspace-merge';
const collections: Record<string, string> = {
  projects: '项目',
  trades: '工种',
  tasks: '施工任务',
  notes: '事项/备忘',
  purchases: '采购',
  people: '人员',
  dictionaries: '字典',
  workspace: '工作空间',
};
const labels: Record<string, string> = {
  name: '名称',
  title: '标题',
  content: '内容',
  notes: '备注',
  status: '状态',
  start: '开始日期',
  end: '结束日期',
  due: '采购日期',
  owner: '负责人',
  manager: '项目经理',
  address: '地址',
  done: '完成状态',
  date: '事项日期',
  order: '排列顺序',
  $record: '整条记录（日期、关联或新增/删除冲突）',
};
function text(value: unknown) {
  if (value === undefined) return '（记录/字段不存在）';
  if (value === '') return '（空）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function WorkspaceSaveConflict({
  conflict,
  onResolve,
  onClose,
}: {
  conflict: SaveConflict;
  onResolve: (choices: MergeChoices) => Promise<void>;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<MergeChoices>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="核对保存冲突"
      subtitle="草稿已保留。只有你确认的冲突字段会被替换，其余修改会自动合并。"
      onClose={onClose}
      blocking
      wide
      className="workspace-save-conflict"
    >
      <div className="modal-body">
        <p>云端版本 {conflict.current.revision} · 以下为读取时的实际内容，提交前仍会再次检查。</p>
        {!conflict.fields.length && (
          <p role="alert">
            关联或日期已变化，无法自动合并。请下载草稿，关闭此窗口后核对云端；没有覆盖任何记录。
          </p>
        )}
        {conflict.fields.map((f) => {
          const record = [
            ...conflict.local.projects,
            ...conflict.local.trades,
            ...conflict.local.tasks,
            ...conflict.local.notes,
            ...conflict.local.purchases,
            ...(conflict.local.people || []),
          ].find((x) => x.id === f.id);
          const name =
            record && ('name' in record ? record.name : 'title' in record ? record.title : '');
          return (
            <fieldset key={f.key} className="save-conflict-field">
              <legend>
                {collections[f.collection] || f.collection} · {name || f.id} ·{' '}
                {labels[f.field] || f.field}
              </legend>
              <details>
                <summary>编辑前的内容</summary>
                <pre>{text(f.base)}</pre>
              </details>
              <div className="save-conflict-options">
                {(['local', 'remote'] as const).map((option) => (
                  <label key={option}>
                    <span>
                      <input
                        type="radio"
                        name={f.key}
                        checked={choices[f.key] === option}
                        onChange={() => setChoices({ ...choices, [f.key]: option })}
                      />
                      {option === 'local' ? '保留我的修改' : '采用云端内容'}
                    </span>
                    <pre>{text(option === 'local' ? f.local : f.remote)}</pre>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="modal-foot">
        <button onClick={() => backupJSON(conflict.local)}>下载草稿备份</button>
        <button onClick={onClose} disabled={busy}>
          稍后处理
        </button>
        <button
          className="primary"
          disabled={busy || !conflict.fields.length || conflict.fields.some((f) => !choices[f.key])}
          onClick={() => {
            setBusy(true);
            setError('');
            void onResolve(choices)
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? '正在核对保存…' : '确认选择并保存'}
        </button>
      </footer>
    </Modal>
  );
}
