import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export type Anchor = { x: number; y: number };
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  anchor,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  anchor?: Anchor;
}) {
  const headingId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const d = ref.current!;
    d.showModal();
    const position = () => {
      if (!anchor || window.innerWidth < 640) return;
      const rect = d.getBoundingClientRect();
      d.style.margin = '0';
      d.style.left = `${Math.max(12, Math.min(anchor.x + 12, window.innerWidth - rect.width - 12))}px`;
      d.style.top = `${Math.max(12, Math.min(anchor.y + 12, window.innerHeight - rect.height - 12))}px`;
    };
    position();
    window.addEventListener('resize', position);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('resize', position);
      d.close();
      document.body.style.overflow = old;
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''} ${anchor ? 'anchored' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-labelledby={headingId}
    >
      <header className="modal-head">
        <div>
          <h2 id={headingId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-btn" aria-label="关闭浮窗" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Confirm({
  title,
  message,
  onCancel,
  onConfirm,
  danger = true,
}: {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="modal-body">
        <p className="confirm-message">{message}</p>
      </div>
      <footer className="modal-foot">
        <button onClick={onCancel}>取消</button>
        <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          确认{danger ? '操作' : ''}
        </button>
      </footer>
    </Modal>
  );
}
