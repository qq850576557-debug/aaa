import { useRef, useState } from 'react';
import { Modal, Confirm } from './Modal';
import { Editor, type Edit, type Entity } from './Forms';
import { RecordDrawer } from './RecordDrawer';
import { id, type Data } from '../lib/model';
import type { WorkRecord } from '../lib/records';
export type AgendaEntryRequest = { projectId: string; date: string; id: string };
export function AgendaEntryDialog({
  request,
  data,
  isCloud,
  onClose,
  onPurchase,
  onRecord,
}: {
  request: AgendaEntryRequest;
  data: Data;
  isCloud: boolean;
  onClose: () => void;
  onPurchase: (kind: Edit['kind'], value: Entity) => void;
  onRecord: (record: WorkRecord) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState<'' | 'purchase' | 'record'>('');
  const [confirmation, setConfirmation] = useState<null | (() => void)>(null);
  const dirty = useRef(false);
  const [purchase] = useState<Edit>(() => ({
    kind: 'purchase',
    value: {
      id: id(),
      projectId: request.projectId,
      name: '',
      due: request.date,
      taskId: '',
      leadDays: 0,
      status: '待采购',
      owner: '',
      notes: '',
    },
  }));
  const choose = (next: 'purchase' | 'record') => {
    if (saving || next === category) return;
    if (category)
      setConfirmation(() => () => {
        dirty.current = false;
        setCategory(next);
      });
    else setCategory(next);
  };
  const intro = (
    <fieldset className="agenda-category-picker">
      <legend>记录类别（必选）</legend>
      <label className={category === 'purchase' ? 'selected' : ''}>
        <input
          type="radio"
          name="agenda-category"
          value="purchase"
          disabled={saving}
          checked={category === 'purchase'}
          onChange={() => choose('purchase')}
        />
        采购清单
      </label>
      <label className={category === 'record' ? 'selected' : ''}>
        <input
          type="radio"
          name="agenda-category"
          value="record"
          disabled={!isCloud || saving}
          checked={category === 'record'}
          onChange={() => choose('record')}
        />
        事项管理
      </label>
      {!isCloud && <small>事项管理沿用现有云端看板，请登录云端工作空间使用。</small>}
    </fieldset>
  );
  return (
    <>
      {!category ? (
        <Modal
          title="新增记录"
          subtitle={`${data.projects.find((p) => p.id === request.projectId)?.name} · ${request.date}`}
          onClose={onClose}
        >
          <div className="modal-body">
            {intro}
            <p className="muted">请先选择类别，再填写对应记录。</p>
          </div>
          <footer className="modal-foot">
            <button onClick={onClose}>取消</button>
            <button className="primary" disabled>
              保存
            </button>
          </footer>
        </Modal>
      ) : category === 'purchase' ? (
        <Editor
          edit={purchase}
          data={data}
          intro={intro}
          onForgetName={() => {}}
          onClose={onClose}
          onSave={onPurchase}
        />
      ) : (
        <RecordDrawer
          projects={data.projects}
          initialProject={request.projectId}
          initialDate={request.date}
          intro={intro}
          onBusyChange={setSaving}
          onDirty={(v) => {
            dirty.current = v;
          }}
          onClose={() => {
            if (dirty.current) setConfirmation(() => onClose);
            else onClose();
          }}
          onSaved={onRecord}
        />
      )}
      {confirmation && (
        <Confirm
          title="放弃当前未保存的内容？"
          message="更换类别或关闭后，当前表单草稿不会提交；已保存记录不受影响。"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            confirmation();
            setConfirmation(null);
          }}
        />
      )}
    </>
  );
}
