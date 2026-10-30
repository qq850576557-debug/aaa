import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { personDropTarget } from './person-sort';
export function usePeopleSort(
  root: RefObject<HTMLDivElement | null>,
  onSort: (source: string, before: string | null) => void,
) {
  const callback = useRef(onSort);
  callback.current = onSort;
  const [source, setSource] = useState<string | null>(null),
    [marker, setMarker] = useState<ReturnType<typeof personDropTarget>>(null);
  const session = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    ghost: HTMLElement | null;
    target: ReturnType<typeof personDropTarget>;
    frame: number;
  } | null>(null);
  const hit = () => {
    const d = session.current,
      grid = root.current;
    if (!d?.ghost || !grid) return;
    d.ghost.style.transform = `translate3d(${d.x - d.offsetX}px,${d.y - d.offsetY}px,0)`;
    const rects = [
      ...grid.querySelectorAll<HTMLElement>(':scope > .person-card[data-person-id]'),
    ].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        id: e.dataset.personId!,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      };
    });
    const next = personDropTarget(rects, d.x, d.y);
    if (
      next?.target !== d.target?.target ||
      next?.edge !== d.target?.edge ||
      next?.before !== d.target?.before ||
      next?.vertical !== d.target?.vertical
    )
      setMarker(next);
    d.target = next;
  };
  const cancel = (event?: PointerEvent<HTMLButtonElement>) => {
    if (event && session.current && event.pointerId !== session.current.pointerId) return;
    const d = session.current;
    session.current = null;
    if (d) {
      cancelAnimationFrame(d.frame);
      d.ghost?.remove();
    }
    setSource(null);
    setMarker(null);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && session.current) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      const d = session.current;
      session.current = null;
      if (d) {
        cancelAnimationFrame(d.frame);
        d.ghost?.remove();
      }
    };
  }, []);
  const tick = () => {
    const d = session.current;
    if (!d?.ghost) return;
    const amount =
      d.y < 100
        ? -Math.min(15, (100 - d.y) / 4)
        : d.y > innerHeight - 70
          ? Math.min(15, (d.y - innerHeight + 70) / 4)
          : 0;
    if (amount) {
      window.scrollBy(0, amount);
      hit();
    }
    d.frame = requestAnimationFrame(tick);
  };
  return {
    source,
    marker,
    start(e: PointerEvent<HTMLButtonElement>, id: string) {
      if (e.button !== 0 || !e.isPrimary || session.current) return;
      e.preventDefault();
      e.stopPropagation();
      const card = e.currentTarget.closest<HTMLElement>('.person-card')!;
      const r = card.getBoundingClientRect();
      e.currentTarget.setPointerCapture(e.pointerId);
      session.current = {
        id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        offsetX: e.clientX - r.left,
        offsetY: e.clientY - r.top,
        ghost: null,
        target: null,
        frame: 0,
      };
    },
    move(e: PointerEvent<HTMLButtonElement>) {
      const d = session.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.ghost && Math.hypot(d.x - d.startX, d.y - d.startY) >= 6) {
        const card = e.currentTarget.closest<HTMLElement>('.person-card')!,
          r = card.getBoundingClientRect();
        d.ghost = card.cloneNode(true) as HTMLElement;
        d.ghost.removeAttribute('data-person-id');
        d.ghost.removeAttribute('id');
        d.ghost.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
        d.ghost.classList.add('person-sort-ghost');
        d.ghost.setAttribute('aria-hidden', 'true');
        d.ghost.inert = true;
        Object.assign(d.ghost.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: r.width + 'px',
          height: r.height + 'px',
          pointerEvents: 'none',
          zIndex: '10000',
        });
        root.current?.append(d.ghost);
        setSource(d.id);
        d.frame = requestAnimationFrame(tick);
      }
      hit();
    },
    end(e: PointerEvent<HTMLButtonElement>) {
      e.stopPropagation();
      const d = session.current;
      if (d && e.pointerId !== d.pointerId) return;
      if (d) {
        d.x = e.clientX;
        d.y = e.clientY;
        hit();
      }
      try {
        if (d?.ghost && d.target && d.target.target !== d.id)
          callback.current(d.id, d.target.before);
      } finally {
        cancel();
      }
    },
    cancel,
  };
}
