import { staffConflicts, staffAssignmentIssues } from '../lib/readiness';
import type { Data, Task } from '../lib/model';
export function ConflictPanel({
  data,
  projectId,
  onTask,
  pending = false,
}: {
  data: Data;
  projectId?: string;
  onTask?: (task: Task) => void;
  pending?: boolean;
}) {
  const conflicts = staffConflicts(data).filter(
    (c) => !projectId || c.a.project.id === projectId || c.b.project.id === projectId,
  );
  const issues = staffAssignmentIssues(data);
  if (!conflicts.length && !issues.length) return null;
  return (
    <section className="conflict-panel" role="status">
      <h3>{conflicts.length ? `人员档期冲突 · ${conflicts.length}` : '人员分配待确认'}</h3>
      <p>
        自然日含首尾；只检测实际已安排任务段，不把项目团队成员推断为全程驻场。不会自动改动其他项目；特殊安排须待真实管理员授权流程。
      </p>
      {pending && <p>本地待同步排班预览；请以云端确认后的排班为准。</p>}
      {issues.map((x, i) => (
        <p key={i}>
          待确认：{x.sourceName}（{x.sourceId}） · 人员ID {x.personId} · {x.reason}
          。原始关联保留，不自动合并。
        </p>
      ))}
      {conflicts.map((c) => (
        <details key={c.id}>
          <summary>
            {c.person.name}（人员ID：{c.person.id}） · 重叠 {c.start} — {c.end} · {c.days}天
          </summary>
          {[c.a, c.b].map((x) => (
            <p key={x.task.id}>
              {x.project.name} · {x.project.address || '未登记地址/房号'} ·{' '}
              {data.trades.find((g) => g.id === x.task.tradeId)?.name} / {x.task.name} ·{' '}
              {x.task.start} — {x.task.end}
              {onTask && (
                <button
                  type="button"
                  onClick={() => onTask(x.task)}
                  aria-label={`核对${x.project.name}的${x.task.name}人员分配`}
                >
                  核对任务分配
                </button>
              )}
            </p>
          ))}
        </details>
      ))}
    </section>
  );
}
