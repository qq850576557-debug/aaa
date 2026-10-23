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
            ? '无明确依赖的任务按工种顺序保守建议：仅包含原本在前序任务之后、现在受到延长覆盖的后续任务。原有交叉施工不移动。'
            : '根据你设置的前序任务关系计算受影响范围。'}
        </p>
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
        <button onClick={onCancel}>取消本次操作</button>
        <button onClick={() => onApply(false)}>仅调整当前工序</button>
        <button className="primary" onClick={() => onApply(true)}>
          顺延后续工期
        </button>
      </footer>
    </Modal>
  );
}
