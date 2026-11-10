import { PurchaseDateHistory } from './PurchaseDateHistory';
import { projectThemeStyle, useProjectTheme } from './ProjectThemes';
import { Pencil, Trash2 } from 'lucide-react';
import './purchase-status.css';
import {
  purchaseDue,
  purchaseComplete,
  purchaseStatuses,
  remainingTime,
  type Data,
  type Purchase,
} from '../lib/model';
export function PurchaseCard({
  purchase: p,
  data,
  now,
  onEdit,
  onStatus,
  onDelete,
  canReopen = true,
  showProject = true,
}: {
  purchase: Purchase;
  data: Data;
  now: string;
  onEdit: () => void;
  onStatus: (status: Purchase['status']) => void;
  onDelete?: () => void;
  canReopen?: boolean;
  showProject?: boolean;
}) {
  const due = purchaseDue(p, data),
    done = purchaseComplete(p);
  return (
    <article
      className={`purchase-row purchase-card ${done ? 'done' : ''}`}
      data-purchase-id={p.id}
      data-purchase-status={p.status}
      style={projectThemeStyle(useProjectTheme(p.projectId))}
    >
      <div className="purchase-actions" role="group" aria-label={`采购操作：${p.name}`}>
        <select
          aria-label={`采购状态${p.name}`}
          value={p.status}
          onChange={(e) => onStatus(e.target.value as Purchase['status'])}
        >
          {purchaseStatuses.map((status) => (
            <option
              key={status}
              value={status}
              disabled={done && !canReopen && (status === '待采购' || status === '已下单')}
            >
              {status}
            </option>
          ))}
        </select>
        <button className="purchase-edit" onClick={onEdit} aria-label={`编辑采购${p.name}`}>
          <Pencil size={14} />
          编辑
        </button>
        {onDelete && (
          <button className="purchase-delete" aria-label={`删除采购${p.name}`} onClick={onDelete}>
            <Trash2 size={14} />
            删除
          </button>
        )}
      </div>
      <div className="purchase-main">
        <div className="purchase-card-title">
          <strong>{p.name}</strong>
        </div>
        <div className="purchase-meta">
          <small>
            {due} 前采购 <PurchaseDateHistory purchase={p} />
          </small>
          <span className={`deadline-countdown ${!done && due < now ? 'red' : ''}`}>
            {p.status === '已到货' ? '采购已到货' : done ? '采购已完成' : remainingTime(due, now)}
          </span>
        </div>
        {p.owner && <small className="purchase-responsible">负责人：{p.owner}</small>}
        {(p.quantity || p.specification) && (
          <small>
            {p.quantity} {p.specification}
          </small>
        )}
        {p.notes && <p>{p.notes}</p>}
        {p.taskId && (
          <small>
            关联：{data.tasks.find((t) => t.id === p.taskId)?.name || '历史施工任务'}
            {p.deadlineMode === 'fixed' ? ' · 手动固定采购日期' : ' · 跟随工期提前，推后不自动延期'}
          </small>
        )}
      </div>
      {showProject && (
        <span className="purchase-project-tag">
          {data.projects.find((x) => x.id === p.projectId)?.name}
        </span>
      )}
    </article>
  );
}
