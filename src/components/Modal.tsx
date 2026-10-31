import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
export type Anchor = { x: number; y: number; element?: HTMLElement };
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  anchor,
  blocking = false,
  className = '',
  placement = 'center',
  animateClose = false,
  inline = false,
  topAligned = false,
}: {
  inline?: boolean;
  topAligned?: boolean;
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  anchor?: Anchor;
  blocking?: boolean;
  className?: string;
  placement?: 'center' | 'right';
  animateClose?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  const headingId = useId(),
    ref = useRef<HTMLDialogElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = () => {
    if (closeTimer.current) return;
    if (!animateClose || matchMedia('(prefers-reduced-motion: reduce)').matches)
      return latestClose.current();
    setClosing(true);
    closeTimer.current = setTimeout(() => latestClose.current(), 150);
  };
  useEffect(() => {
    if (inline) return;
    const d = ref.current!,
      previous = document.activeElement as HTMLElement | null,
      oldOverflow = document.body.style.overflow;
    if (blocking) {
      d.showModal();
      document.body.style.overflow = 'hidden';
    } else d.show();
    const initial = anchor?.element?.getBoundingClientRect();
    const position = () => {
      const rect = d.getBoundingClientRect(),
        w = window.innerWidth,
        h = window.innerHeight;
      if (placement === 'right') {
        d.style.left = `${Math.max(0, w - rect.width)}px`;
        d.style.top = '0px';
        return;
      }
      const source = anchor?.element?.isConnected ? anchor.element.getBoundingClientRect() : null;
      const x = anchor ? anchor.x + (source && initial ? source.left - initial.left : 0) : w / 2;
      const y = anchor ? anchor.y + (source && initial ? source.top - initial.top : 0) : h / 2;
      const useAnchor = !!anchor && w >= 640;
      d.style.left = `${Math.max(12, Math.min(useAnchor ? x + 12 : (w - rect.width) / 2, w - rect.width - 12))}px`;
      d.style.top = topAligned
        ? `${w < 640 ? 12 : 24}px`
        : `${Math.max(12, Math.min(useAnchor ? y + 12 : (h - rect.height) / 2, h - rect.height - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(d);
    // A range editor mounts on pointerup. Its following click belongs to the
    // opening gesture, not an outside press; never dismiss that new panel.
    let outsidePress = false;
    const pointerDown = (e: PointerEvent) => {
      outsidePress = !d.contains(e.target as Node);
    };
    const outside = (e: MouseEvent) => {
      if (e.detail > 0 && !outsidePress) return;
      outsidePress = false;
      if (
        blocking ||
        placement === 'right' ||
        d.contains(e.target as Node) ||
        (document.querySelector('dialog:modal') &&
          !document.querySelector('dialog:modal')!.contains(d))
      )
        return;
      const last = [...document.querySelectorAll('dialog[open]')].at(-1);
      if (last !== d) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    const escape = (e: KeyboardEvent) => {
      if (
        blocking ||
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        (document.querySelector('dialog:modal') &&
          !document.querySelector('dialog:modal')!.contains(d)) ||
        document.querySelector('[popover]:popover-open')
      )
        return;
      const last = [...document.querySelectorAll('dialog[open]')].at(-1);
      if (last === d) {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('click', outside, true);
      document.removeEventListener('keydown', escape);
      d.close();
      if (blocking) document.body.style.overflow = oldOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  if (inline) return <section className={`inline-form ${className}`}>{children}</section>;
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''} ${anchor ? 'anchored' : ''} ${blocking ? 'blocking-panel' : 'floating-panel'} ${placement === 'right' ? 'drawer' : ''} ${closing ? 'closing' : ''} ${className}`}
      aria-modal={blocking}
      aria-labelledby={headingId}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }}
      onClick={(e) => {
        if (!blocking || e.target !== ref.current) return;
        const r = ref.current.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          closeRef.current();
      }}
    >
      <header className="modal-head">
        <div>
          <h2 id={headingId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-btn" aria-label="关闭浮窗" onClick={() => closeRef.current()}>
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
    <Modal title={title} onClose={onCancel} blocking>
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
