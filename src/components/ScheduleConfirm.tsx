import { useRef, type PointerEvent } from 'react';
import { Modal } from './Modal';
import type { ScheduleProposal } from '../lib/scheduling';
export function ScheduleConfirm({
  proposal,
  onApply,
  onCancel,
}: {
  proposal: ScheduleProposal;
  onApply: (shift: boolean) => void;
  onCancel: () => void;
}) {
  const applied = useRef(false);
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const once = (action: () => void) => {
    if (applied.current) return;
    applied.current = true;
    action();
  };
  // A dragged touch can suppress Chromium's compatibility click. Complete a
  // deliberate touch press on pointerup, and deduplicate its later native click.
  const activation = (action: () => void) => ({
    onClick: () => once(action),
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'touch' && e.isPrimary)
        press.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    },
    onPointerCancel: () => {
      press.current = null;
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType !== 'touch') return;
      const start = press.current;
      press.current = null;
      const r = e.currentTarget.getBoundingClientRect();
      if (
        start?.id === e.pointerId &&
        Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10 &&
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      ) {
        e.preventDefault();
        once(action);
      }
    },
  });
  const project = proposal.shifted.projects.find(
    (p) => p.id === proposal.affected[0]?.after.projectId,
  );
  return (
    <Modal
      title="是否顺延后续工期？"
      subtitle="本次调整可能影响后续施工安排。确认前尚未保存任何日期变化。"
      onClose={onCancel}
      wide
    >
      <div className="modal-body">
        <p className="confirm-message">
          建议顺延 {proposal.affected.length} 段未完成任务，保留各任务原有持续天数。项目计划完工：
          {project?.end}。
        </p>
        <p className="form-info">
          {proposal.inferred
            ? '无明确依赖的任务按工种顺序保守建议：仅建议调整被新增时间段覆盖，或原本在前序之后、现受到延长影响的后续任务。原有任务间的交叉施工不移动。'
            : '根据你设置的前序任务关系计算受影响范围。'}
        </p>
        {proposal.shiftError && (
          <p className="error" role="alert">
            顺延方案超出可保存范围：{proposal.shiftError}。可以仅调整当前工序，或取消本次操作。
          </p>
        )}
        <div className="shift-preview">
          {proposal.affected.map(({ before, after }) => (
            <div key={after.id}>
              <strong>{after.name}</strong>
              <span>
                {before.start} — {before.end}
              </span>
              <span>
                → {after.start} — {after.end}
              </span>
            </div>
          ))}
        </div>
      </div>
      <footer className="modal-foot">
        <button {...activation(onCancel)}>取消本次操作</button>
        <button {...activation(() => onApply(false))}>仅调整当前工序</button>
        <button
          className="primary"
          disabled={!!proposal.shiftError}
          {...activation(() => onApply(true))}
        >
          顺延后续工期
        </button>
      </footer>
    </Modal>
  );
}
