import { Check } from 'lucide-react';
import type { AgendaItem as Item } from '../lib/agenda';
import { ProjectSurface } from './ProjectThemes';
export function AgendaItem({
  item,
  projectName,
  onOpen,
  onToggle,
  busy,
  canToggle = true,
  compact = false,
  onDelete,
}: {
  item: Item;
  projectName: string;
  onOpen: () => void;
  onToggle: () => void;
  busy?: boolean;
  canToggle?: boolean;
  compact?: boolean;
  onDelete?: () => void;
}) {
  const category = item.kind === 'purchase' ? '采购' : '事项';
  return (
    <ProjectSurface projectId={item.projectId} className={`agenda-item ${item.done ? 'done' : ''}`}>
      <button
        className="agenda-item-main"
        disabled={busy}
        onClick={onOpen}
        aria-label={`打开${category}：${item.title}`}
      >
        <strong>{item.title}</strong>
        <span className="agenda-item-meta">
          <span className={`agenda-category category-${item.kind}`}>{category}</span>
          <span>{projectName}</span>
          <time dateTime={item.date}>{item.date || '未设日期'}</time>
          <span className="status-tag">{item.status}</span>
        </span>
      </button>
      <div className="agenda-item-actions">
        <button
          className="agenda-complete"
          disabled={busy || !canToggle}
          aria-label={`${item.done ? '恢复待处理' : '完成'}${item.title}`}
          onClick={onToggle}
        >
          <Check size={15} />
          <span>{busy ? '保存中' : compact ? item.status : item.done ? '已完成' : '完成'}</span>
        </button>
        {onDelete && (
          <>
            <button disabled={busy} onClick={onOpen}>
              编辑
            </button>
            <button className="danger" disabled={busy} onClick={onDelete}>
              删除
            </button>
          </>
        )}
      </div>
    </ProjectSurface>
  );
}
