import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { desktopV1Enabled, enhancedGlassEnabled } from '../ui-v1/mode';
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
  compactHeader = false,
  enhancedGlass = false,
  protect = 'draft',
}: {
  protect?: 'draft' | 'managed' | 'view';
  inline?: boolean;
  topAligned?: boolean;
  compactHeader?: boolean;
  enhancedGlass?: boolean;
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
  const [discard, setDiscard] = useState(false);
  const edited = useRef(false);
  const policy = useRef(protect);
  policy.current = protect;
  const requestClose = () => {
    if (policy.current === 'draft' && edited.current) setDiscard(true);
    else closeRef.current();
  };
  const glass = !inline && desktopV1Enabled();
  const optical =
    glass &&
    blocking &&
    enhancedGlass &&
    !anchor &&
    placement === 'center' &&
    enhancedGlassEnabled();
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
      if (glass) document.dispatchEvent(new Event('chunmo:glass-stack'));
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
        policy.current !== 'view' ||
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
        if (policy.current === 'view') closeRef.current();
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
      if (blocking) {
        document.body.style.overflow = oldOverflow;
        if (glass) document.dispatchEvent(new Event('chunmo:glass-stack'));
      }
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!optical || !ref.current) return;
    const dialog = ref.current;
    let cancelled = false;
    let detach: (() => void) | undefined;
    void import('../ui-v1/glass')
      .then(({ attachGlass }) => {
        if (!cancelled) detach = attachGlass(dialog);
      })
      .catch(() => {
        // The ordinary glass treatment remains usable if enhanced optics cannot load.
        if (!cancelled) dialog.dataset.cmGlass = 'frosted';
      });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [optical]);
  if (inline) return <section className={`inline-form ${className}`}>{children}</section>;
  return (
    <>
      <dialog
        ref={ref}
        data-cm-glass={glass ? 'frosted' : undefined}
        data-cm-glass-enhanced={optical ? '' : undefined}
        className={`modal ${wide ? 'wide' : ''} ${anchor ? 'anchored' : ''} ${blocking ? 'blocking-panel' : 'floating-panel'} ${placement === 'right' ? 'drawer' : ''} ${closing ? 'closing' : ''} ${glass ? 'cm-glass' : ''} ${className}`}
        aria-modal={blocking}
        aria-labelledby={headingId}
        onCancel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (protect === 'view') closeRef.current();
        }}
        onChangeCapture={(event) => {
          if (protect !== 'draft' || !(event.target instanceof HTMLElement)) return;
          const field = event.target;
          if (field.closest('dialog') !== ref.current || field.closest('[data-modal-ignore]'))
            return;
          if (
            field.matches(
              'input:not([readonly]):not([type=search]), select, textarea:not([readonly])',
            )
          )
            edited.current = true;
        }}
        onClickCapture={(event) => {
          if (protect !== 'draft' || !edited.current || !(event.target instanceof Element)) return;
          const button = event.target.closest('button');
          if (button?.closest('dialog') !== ref.current || !button?.closest('footer')) return;
          if (!['取消', '关闭'].includes(button?.textContent?.trim() ?? '')) return;
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
        onClick={(e) => {
          if (protect !== 'view' || !blocking || e.target !== ref.current) return;
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            closeRef.current();
        }}
      >
        <header className={`modal-head${compactHeader ? ' modal-head-compact' : ''}`}>
          <div className={compactHeader ? 'sr-only' : undefined}>
            <h2 id={headingId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" aria-label="关闭浮窗" onClick={requestClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </dialog>
      {discard && (
        <Confirm
          title="放弃未保存的修改？"
          message="返回可继续编辑，确认后会关闭当前弹窗。"
          onCancel={() => setDiscard(false)}
          onConfirm={() => {
            setDiscard(false);
            edited.current = false;
            closeRef.current();
          }}
        />
      )}
    </>
  );
}
export function Confirm({
  title,
  message,
  onCancel,
  onConfirm,
  danger = true,
  busy = false,
  error,
}: {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  danger?: boolean;
  busy?: boolean;
  error?: string;
}) {
  return (
    <Modal title={title} onClose={() => !busy && onCancel()} blocking>
      <div className="modal-body">
        <p className="confirm-message">{message}</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-foot">
        <button disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          disabled={busy}
          aria-busy={busy}
          className={danger ? 'danger' : 'primary'}
          onClick={onConfirm}
        >
          {busy ? '正在处理…' : `确认${danger ? '操作' : ''}`}
        </button>
      </footer>
    </Modal>
  );
}
