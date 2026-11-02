import { useRef, useState } from 'react';
import { Modal, Confirm } from './Modal';
import { Editor, type Edit, type Entity } from './Forms';
import { RecordDrawer } from './RecordDrawer';
import { id, type Data, type Purchase } from '../lib/model';
import type { WorkRecord, RecordValue } from '../lib/records';
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
  const drafts = useRef<{ purchase?: Purchase; record?: RecordValue }>({});
  const transferred = useRef(false);
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
    const switchCategory = () => {
      if (dirty.current) {
        transferred.current = true;
        if (next === 'record' && drafts.current.purchase) {
          const p = drafts.current.purchase;
          drafts.current.record = {
            ...drafts.current.record,
            projectId: p.projectId,
            title: p.name,
            nodeDate: p.due,
            notes: p.notes,
            owner: p.owner,
            mentionIds: p.mentionIds,
            followUp: drafts.current.record?.followUp ?? '',
            status: drafts.current.record?.status ?? '待执行',
          };
        }
        if (next === 'purchase' && drafts.current.record) {
          const r = drafts.current.record;
          drafts.current.purchase = {
            ...(drafts.current.purchase ?? (purchase.value as Purchase)),
            projectId: r.projectId,
            name: r.title,
            due: r.nodeDate,
            notes: r.notes,
            owner: r.owner ?? '',
            mentionIds: r.mentionIds,
          };
        }
      }
      dirty.current = transferred.current;
      setCategory(next);
    };
    if (category && dirty.current) setConfirmation(() => switchCategory);
    else {
      switchCategory();
    }
  };
  const intro = (
    <fieldset className="agenda-category-picker">
      <legend>记录类别（必选）</legend>
      <label className={`category-purchase ${category === 'purchase' ? 'selected' : ''}`}>
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
      <label className={`category-record ${category === 'record' ? 'selected' : ''}`}>
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
      <Modal
        title={category === 'purchase' ? '新建采购事项' : '新增记录'}
        subtitle={`${data.projects.find((p) => p.id === request.projectId)?.name} · ${request.date}`}
        className="agenda-entry-dialog"
        topAligned
        onClose={() => {
          if (saving) return;
          if (dirty.current) setConfirmation(() => onClose);
          else onClose();
        }}
      >
        <div className="agenda-entry-selector">{intro}</div>
        <div className="agenda-entry-content" key={category || 'unselected'}>
          {!category ? (
            <>
              <p className="muted agenda-entry-hint">请先选择类别，再填写对应记录。</p>
              <footer className="modal-foot">
                <button onClick={onClose}>取消</button>
                <button className="primary" disabled>
                  保存
                </button>
              </footer>
            </>
          ) : category === 'purchase' ? (
            <Editor
              embedded
              edit={{ ...purchase, value: drafts.current.purchase ?? purchase.value } as Edit}
              data={data}
              onDirtyChange={(v) => {
                dirty.current = v || transferred.current;
              }}
              onDraftChange={(value) => {
                drafts.current.purchase = value as Purchase;
              }}
              onForgetName={() => {}}
              onClose={onClose}
              onSave={onPurchase}
            />
          ) : (
            <RecordDrawer
              embedded
              projects={data.projects}
              initialProject={request.projectId}
              initialDate={request.date}
              initialValue={drafts.current.record}
              onDraftChange={(value) => {
                drafts.current.record = value;
              }}
              onBusyChange={setSaving}
              onDirty={(v) => {
                dirty.current = v || transferred.current;
              }}
              onClose={() => {
                if (dirty.current) setConfirmation(() => onClose);
                else onClose();
              }}
              onSaved={onRecord}
              onQueued={onClose}
            />
          )}
        </div>
      </Modal>
      {confirmation && (
        <Confirm
          title="放弃当前未保存的内容？"
          message="切换类别会保留工地、日期、标题、负责人和备注，专属字段保留在各自草稿中；关闭将放弃本次输入，已保存记录不受影响。"
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
