import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../lib/model';
export function TaskContextMenu({
  task,
  point,
  onClose,
  onEdit,
  onDelete,
}: {
  task: Task;
  point: { x: number; y: number };
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const menu = ref.current!;
    const position = () => {
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(point.x, innerWidth - r.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(point.y, innerHeight - r.height - 8))}px`;
    };
    position();
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (e: globalThis.PointerEvent) => {
      if (!menu.contains(e.target as Node)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [point.x, point.y]);
  return createPortal(
    <div ref={ref} className="task-context-menu" role="menu" aria-label={`${task.name}时间条操作`}>
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onEdit();
        }}
      >
        编辑任务详情
      </button>
      <button
        role="menuitem"
        className="destructive"
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        删除时间条
      </button>
    </div>,
    document.body,
  );
}
