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
}: {
  item: Item;
  projectName: string;
  onOpen: () => void;
  onToggle: () => void;
  busy?: boolean;
  canToggle?: boolean;
}) {
  const category = item.kind === 'purchase' ? '采购' : '事项';
  return (
    <ProjectSurface projectId={item.projectId} className={`agenda-item ${item.done ? 'done' : ''}`}>
      <button
        className="agenda-item-main"
        onClick={onOpen}
        aria-label={`打开${category}：${item.title}`}
      >
        <strong>{item.title}</strong>
        <span className="agenda-item-meta">
          <span className={`agenda-category category-${item.kind}`}>{category}</span>
          <span>{projectName}</span>
          <time dateTime={item.date}>{item.date}</time>
          <span className="status-tag">{item.status}</span>
        </span>
      </button>
      <button
        className="agenda-complete"
        disabled={busy || !canToggle}
        aria-label={`${item.done ? '恢复待处理' : '完成'}${item.title}`}
        onClick={onToggle}
      >
        <Check size={15} />
        <span>{busy ? '保存中' : item.done ? '已完成' : '完成'}</span>
      </button>
    </ProjectSurface>
  );
}
