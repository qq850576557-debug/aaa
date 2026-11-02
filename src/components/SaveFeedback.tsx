import { pendingRecords, verifiedOwner } from '../lib/record-outbox';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
export const savedFeedback = (
  key: string,
  kind: 'workspace' | 'record' | 'restore' = 'workspace',
) => window.dispatchEvent(new CustomEvent('chunmo-save-confirmed', { detail: { key, kind } }));
export const failedFeedback = () => window.dispatchEvent(new Event('chunmo-save-failed'));
export function SaveFeedback({
  children,
  status,
  cloud = true,
}: {
  children?: ReactNode;
  status: string;
  cloud?: boolean;
}) {
  const [message, setMessage] = useState('');
  const [fading, setFading] = useState(false);
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [undoEligible, setUndo] = useState(false);
  const last = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const workspace = useRef({ pending: false, failed: false, local: false, active: false });
  const record = useRef({ pending: false, failed: false });
  const confirmed = cloud ? '云端已保存' : '本地已保存';
  const present = (success = false) => {
    clearTimeout(timer.current);
    clearTimeout(fade.current);
    setFading(false);
    if (workspace.current.failed || record.current.failed)
      setMessage('同步失败，请保留本地内容并核对');
    else if (workspace.current.pending || record.current.pending)
      setMessage('本地已保存 · 云端同步中');
    else if (success) {
      setMessage(confirmed);
      fade.current = setTimeout(() => setFading(true), 2700);
      timer.current = setTimeout(() => setMessage(''), 3000);
    }
  };
  useEffect(() => {
    if (/失败|冲突|未保存|草稿待恢复|等待重试/.test(status)) {
      workspace.current.pending = true;
      workspace.current.failed = true;
      present();
    } else if (status === '正在续传') {
      workspace.current = { pending: true, failed: false, local: true, active: true };
      clearTimeout(timer.current);
      clearTimeout(fade.current);
      setFading(false);
      setMessage('本地草稿已恢复 · 云端同步中');
    } else if (status === '正在保存') {
      workspace.current.pending = true;
      workspace.current.failed = false;
      workspace.current.active = true;
      clearTimeout(timer.current);
      clearTimeout(fade.current);
      setFading(false);
      setMessage(workspace.current.local ? '本地已保存 · 云端同步中' : '正在保存到本地');
    } else if (status === '已保存') {
      workspace.current.pending = false;
      workspace.current.failed = false;
      workspace.current.local = false;
      const active = workspace.current.active;
      workspace.current.active = false;
      present(active);
    }
  }, [status, confirmed]);
  useEffect(() => {
    const show = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.key || last.current === detail.key) return;
      last.current = detail.key;
      setUndo(detail.kind === 'workspace');
      present(true);
    };
    const local = () => {
      workspace.current.pending = true;
      workspace.current.local = true;
      workspace.current.failed = false;
      workspace.current.active = true;
      present();
    };
    const recordStatus = (e: Event) => {
      const text = String((e as CustomEvent).detail);
      record.current.pending = text !== '云端已保存';
      record.current.failed = /失败|冲突|异常/.test(text);
      setUndo(false);
      present(!record.current.pending);
    };
    const failed = () => {
      clearTimeout(timer.current);
      clearTimeout(fade.current);
      setFading(false);
      setMessage('同步失败，请保留当前页面并核对内容');
    };
    const owner = verifiedOwner();
    if (owner)
      void pendingRecords(owner)
        .then((entries) => {
          if (entries.length) {
            record.current.pending = true;
            record.current.failed = entries.some((e) => e.blocked);
            present();
          }
        })
        .catch(() => {});
    window.addEventListener('chunmo-save-confirmed', show);
    window.addEventListener('chunmo-workspace-local-saved', local);
    window.addEventListener('chunmo-outbox-status', recordStatus);
    window.addEventListener('chunmo-save-failed', failed);
    return () => {
      clearTimeout(timer.current);
      clearTimeout(fade.current);
      window.removeEventListener('chunmo-save-confirmed', show);
      window.removeEventListener('chunmo-workspace-local-saved', local);
      window.removeEventListener('chunmo-outbox-status', recordStatus);
      window.removeEventListener('chunmo-save-failed', failed);
    };
  }, [confirmed]);
  return message
    ? createPortal(
        <div className={`save-feedback ${fading ? 'is-fading' : ''}`} role="status">
          <span>{message}</span>
          {message === confirmed && undoEligible && children}
        </div>,
        document.body,
      )
    : null;
}
