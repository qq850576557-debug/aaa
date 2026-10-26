import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../lib/model';
export function TaskContextMenu({
  task,
  members,
  onSelect,
  point,
  onClose,
  onEdit,
  onDelete,
}: {
  task: Task;
  members?: Task[];
  onSelect?: (id: string) => void;
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
      {members && members.length > 1 && (
        <label>
          合并显示，选择原始记录
          <select
            aria-label="选择原始任务记录"
            value={task.id}
            onChange={(e) => onSelect?.(e.target.value)}
          >
            {members.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.start} — {t.end}
              </option>
            ))}
          </select>
        </label>
      )}
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
