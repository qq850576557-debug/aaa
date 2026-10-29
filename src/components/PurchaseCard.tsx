import { projectThemeStyle, useProjectTheme } from './ProjectThemes';
import { useState } from 'react';
import { Modal } from './Modal';
import { cloudApi } from '../lib/cloud';
import { Check, Pencil, Trash2, History } from 'lucide-react';
import {
  purchaseDue,
  purchaseComplete,
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
  isCloud = false,
  tracking,
  showProject = true,
}: {
  purchase: Purchase;
  data: Data;
  now: string;
  onEdit: () => void;
  onStatus: (status: Purchase['status']) => void;
  onDelete?: () => void;
  canReopen?: boolean;
  isCloud?: boolean;
  showProject?: boolean;
  tracking?: {
    createdName?: string;
    createdAt?: string;
    updatedName?: string;
    updatedAt?: string;
    completedName?: string;
    completedAt?: string;
  };
}) {
  const [history, setHistory] = useState<{
      events: {
        actorName: string;
        at: string;
        operation: string;
        before?: Purchase;
        after?: Purchase;
      }[];
    } | null>(null),
    [error, setError] = useState('');
  const time = (v?: string) =>
    v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '历史信息未知';
  const due = purchaseDue(p, data),
    done = purchaseComplete(p);
  return (
    <article
      className={`purchase-row purchase-card ${done ? 'done' : ''}`}
      data-purchase-id={p.id}
      style={projectThemeStyle(useProjectTheme(p.projectId))}
    >
      <div className="purchase-main">
        <div className="purchase-card-title">
          <strong>{p.name}</strong>
          <span className="purchase-status-tag">{p.status}</span>
        </div>
        <small>
          {showProject && (
            <span className="purchase-project-tag">
              {data.projects.find((x) => x.id === p.projectId)?.name}
            </span>
          )}
          {due} 前采购
        </small>
        <span className={`deadline-countdown ${!done && due < now ? 'red' : ''}`}>
          {done ? '采购已完成' : remainingTime(due, now)}
        </span>
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
      <div className="purchase-actions" role="group" aria-label={`采购操作：${p.name}`}>
        <select
          aria-label={`采购状态${p.name}`}
          value={p.status}
          onChange={(e) => onStatus(e.target.value as Purchase['status'])}
        >
          <option disabled={done && !canReopen}>待采购</option>
          <option disabled={done && !canReopen}>已下单</option>
          <option>已完成</option>
          {p.status === '已到货' && <option>已到货</option>}
        </select>
        <button className="purchase-edit" onClick={onEdit} aria-label={`编辑采购${p.name}`}>
          <Pencil size={14} />
          编辑
        </button>
        {!done && (
          <button
            className="purchase-complete"
            onClick={() => onStatus('已完成')}
            aria-label={`完成采购${p.name}`}
          >
            <Check size={14} />
            完成
          </button>
        )}
        {onDelete && (
          <button className="purchase-delete" aria-label={`删除采购${p.name}`} onClick={onDelete}>
            <Trash2 size={14} />
            删除
          </button>
        )}
        {isCloud && (
          <button
            className="purchase-history"
            onClick={() => {
              setError('');
              void cloudApi<NonNullable<typeof history>>(
                '/purchase-records/' + encodeURIComponent(p.id) + '/history',
              )
                .then(setHistory)
                .catch((e) => setError(String(e)));
            }}
          >
            <History size={14} />
            采购历史
          </button>
        )}
      </div>
      {isCloud && (
        <details className="purchase-trace" open>
          <summary>责任与时间</summary>
          <p>
            创建：{tracking?.createdName || '历史记录未知'} · {time(tracking?.createdAt)}
          </p>
          <p>
            最后修改：{tracking?.updatedName || '历史记录未知'} · {time(tracking?.updatedAt)}
          </p>
          {tracking?.completedAt && (
            <p>
              最近完成：{tracking.completedName} · {time(tracking.completedAt)}
            </p>
          )}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      {history && (
        <Modal title={`采购历史 · ${p.name}`} onClose={() => setHistory(null)}>
          <div className="modal-body">
            {history.events.length ? (
              history.events.map((e, i) => (
                <article key={i}>
                  <strong>
                    {e.operation} · {e.actorName}
                  </strong>
                  <p>
                    {time(e.at)} · {e.before?.status || '无'} → {e.after?.status || '已删除'}
                  </p>
                </article>
              ))
            ) : (
              <p>该历史采购尚无可信操作记录。</p>
            )}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setHistory(null)}>关闭</button>
          </footer>
        </Modal>
      )}
    </article>
  );
}
