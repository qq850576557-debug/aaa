import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
export const savedFeedback = (
  key: string,
  kind: 'workspace' | 'record' | 'restore' = 'workspace',
) => window.dispatchEvent(new CustomEvent('chunmo-save-confirmed', { detail: { key, kind } }));
export const failedFeedback = () => window.dispatchEvent(new Event('chunmo-save-failed'));
export function SaveFeedback({ children, status }: { children?: ReactNode; status: string }) {
  const [visible, setVisible] = useState(false),
    last = useRef('');
  const [undoEligible, setUndoEligible] = useState(false);
  useEffect(() => {
    if (/失败|冲突|未保存|草稿|未完成/.test(status)) setVisible(false);
  }, [status]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const show = (e: Event) => {
      const key = (e as CustomEvent).detail?.key;
      if (!key || key === last.current) return;
      last.current = key;
      setUndoEligible((e as CustomEvent).detail?.kind === 'workspace');
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 5000);
    };
    window.addEventListener('chunmo-save-confirmed', show);
    const hide = () => {
      clearTimeout(timer);
      setVisible(false);
    };
    window.addEventListener('chunmo-save-failed', hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('chunmo-save-confirmed', show);
      window.removeEventListener('chunmo-save-failed', hide);
    };
  }, []);
  const pending = status === '正在保存' || status === '正在恢复';
  return !/失败|冲突|未保存|草稿|未完成/.test(status) && (visible || pending)
    ? createPortal(
        <div className="save-feedback" role="status">
          <span>{pending ? status + '…' : '已保存'}</span>
          {status === '已保存' && undoEligible && children}
        </div>,
        document.body,
      )
    : null;
}
