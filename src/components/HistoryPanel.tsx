import { useState } from 'react';
import { format } from 'date-fns';
import { Confirm, Modal, type Anchor } from './Modal';
import { GLOBAL_SCOPE, RETENTION, type History, type Revision } from '../lib/history';
import type { Data } from '../lib/model';
export const localTime = (iso: string) => format(new Date(iso), 'yyyy-MM-dd HH:mm:ss');
export function HistoryPanel({
  data,
  history,
  scope,
  anchor,
  error,
  onClose,
  onRestore,
  canRestore,
}: {
  data: Data;
  history: History;
  scope: string;
  anchor?: Anchor;
  error: string;
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
  canRestore: boolean;
}) {
  const [full, setFull] = useState(false),
    [selected, setSelected] = useState(scope),
    [detail, setDetail] = useState<string | null>(null);
  const [target, setTarget] = useState<Revision | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState('');
  const now = Date.now();
  const records = history.records
    .filter(
      (r) => r.scope === selected && Date.parse(r.at) >= now - RETENTION && Date.parse(r.at) <= now,
    )
    .slice()
    .reverse();
  const projects = new Map(data.projects.map((p) => [p.id, p.name]));
  for (const r of history.records)
    if (r.scope !== GLOBAL_SCOPE && !projects.has(r.scope))
      projects.set(r.scope, `${r.name}（已删除，可恢复）`);
  const name =
    selected === GLOBAL_SCOPE ? '全局人员与工作空间' : (projects.get(selected) ?? '当前项目');
  return (
    <>
      <Modal
        title={full ? '完整修改历史' : '最近15天修改历史'}
        subtitle={`${name} · 本地操作记录`}
        onClose={onClose}
        anchor={anchor}
        className={`history-panel ${full ? 'history-full' : ''}`}
      >
        <div className="modal-body">
          <p className="form-info">
            保留最近15天成功保存的版本。恢复到某次修改前会替换该范围完整数据，后续历史仍保留。不是云备份或身份审计。
          </p>
          {(full || selected === GLOBAL_SCOPE) && (
            <label className="form-field">
              历史范围
              <select
                aria-label="历史范围"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setDetail(null);
                }}
              >
                {[...projects].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
                <option value={GLOBAL_SCOPE}>全局人员与工作空间（独立恢复）</option>
              </select>
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {failure && (
            <p className="error" role="alert">
              {failure}
            </p>
          )}
          {!records.length && (
            <p className="empty-history">暂无修改历史。接入前的历史无法追溯，不生成虚构记录。</p>
          )}
          {records.slice(0, full ? records.length : 8).map((r) => (
            <article className="revision-card" key={r.id} data-revision-id={r.id}>
              <div>
                <strong>{localTime(r.at)}</strong>
                <span>
                  {r.action} · {r.actor}
                </span>
              </div>
              <p>{[...new Set(r.changes.map((c) => c.module))].join('、') || '版本恢复'}</p>
              <p>
                {r.changes[0]?.label ?? '恢复到所选版本'}
                {r.changes.length > 1 ? ` 等 ${r.changes.length} 处变更` : ''}
              </p>
              <div className="revision-actions">
                <button onClick={() => setDetail(detail === r.id ? null : r.id)}>
                  查看修改详情
                </button>
                <button
                  disabled={!canRestore || busy || !!error}
                  onClick={() => {
                    setFailure('');
                    setTarget(r);
                  }}
                >
                  恢复到修改前
                </button>
              </div>
              {detail === r.id && (
                <div className="revision-differences">
                  {r.source && <p>恢复来源：{r.source}</p>}
                  {r.changes.map((c, i) => (
                    <div key={i}>
                      <strong>
                        {c.module} · {c.label}
                      </strong>
                      <div>
                        <del>{c.before}</del>
                        <ins>{c.after}</ins>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
        <footer className="modal-foot">
          <button onClick={onClose}>关闭</button>
          {!full && (
            <button className="primary" onClick={() => setFull(true)}>
              查看完整历史
            </button>
          )}
        </footer>
      </Modal>
      {target && (
        <Confirm
          title="恢复到此次修改之前？"
          message={`将恢复「${target.name}」在 ${localTime(target.at)} 该次修改前的完整状态。涉及：${[...new Set(target.changes.map((c) => c.module))].join('、') || '版本数据'}。${target.scope === GLOBAL_SCOPE ? '仅恢复全局人员、人员字典、姓名候选、颜色偏好和项目顺序，不覆盖项目内容；若人员关联不完整将拒绝恢复。' : '仅替换该项目的基本资料、人员关联、工种、施工任务、事项与采购，不改其他项目。'}当前状态将在同一事务中保留为新历史，后续历史不会删除。`}
          onCancel={() => !busy && setTarget(null)}
          onConfirm={() => {
            if (busy) return;
            setBusy(true);
            void onRestore(target.id)
              .then(() => {
                setTarget(null);
                setDetail(null);
              })
              .catch((e) => {
                setFailure(
                  `恢复失败：${e instanceof Error ? e.message : String(e)}。恢复前的数据保持不变。`,
                );
                setTarget(null);
              })
              .finally(() => setBusy(false));
          }}
        />
      )}
    </>
  );
}
