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
  return (
    <Modal
      title={proposal.advance ? '当前工序已提前，是否同步提前后续工序？' : '是否顺延后续工期？'}
      onClose={onCancel}
      className="schedule-decision"
    >
      {proposal.shiftError && (
        <p className="decision-error error" role="alert">
          {proposal.advance ? '提前' : '顺延'}方案超出可保存范围，请仅调整当前工序或取消。
        </p>
      )}
      <footer className="modal-foot">
        <button {...activation(onCancel)}>取消本次操作</button>
        <button {...activation(() => onApply(false))}>
          {proposal.advance ? '不调整' : '仅调整当前工序'}
        </button>
        <button
          className="primary"
          disabled={!!proposal.shiftError}
          {...activation(() => onApply(true))}
        >
          {proposal.advance ? '同步提前' : '顺延后续工期'}
        </button>
      </footer>
    </Modal>
  );
}
