import { useId, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { DateField } from './DateField';
import { purchaseCeiling, purchaseDue, type Data, type Purchase } from '../lib/model';
export function PurchaseDeadlineDialog({
  purchase: p,
  data,
  onClose,
  onConfirm,
  cloud = false,
}: {
  purchase: Purchase;
  data: Data;
  onClose: () => void;
  onConfirm: (date: string, reason: string) => void | Promise<void>;
  cloud?: boolean;
}) {
  const reasonId = useId();
  const [date, setDate] = useState(purchaseCeiling(p, data)),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      await onConfirm(date, reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="确认变更原定采购期限" blocking onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <p className="form-info span2">
            {p.name} · 原始截止 {p.originalDue ?? purchaseDue(p, data)} · 当前最晚{' '}
            {purchaseCeiling(p, data)}。原始日期永久保留，本次原因与新约束进入备份记录。
          </p>
          <p className="span2">
            {cloud
              ? '云端模式：仅工作室负责人可提交，服务端校验版本、原始截止和变更记录。'
              : '当前为本地模式：这是明确确认流程，不是负责人账号授权。尚未实现服务端权限校验。'}
          </p>
          <DateField label="新的最晚采购期限" required value={date} onChange={setDate} />
          <div className="form-field span2">
            <label htmlFor={reasonId}>变更原因</label>
            <textarea
              id={reasonId}
              required
              maxLength={4000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {error && (
            <p className="error span2" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={saving}>
            确认变更期限
          </button>
        </footer>
      </form>
    </Modal>
  );
}
