import { staffConflicts } from '../lib/readiness';
import type { Data } from '../lib/model';
export function ConflictPanel({ data, projectId }: { data: Data; projectId?: string }) {
  const conflicts = staffConflicts(data).filter(
    (c) => !projectId || c.a.project.id === projectId || c.b.project.id === projectId,
  );
  if (!conflicts.length) return null;
  return (
    <section className="conflict-panel" role="status">
      <h3>人员档期冲突 · {conflicts.length}</h3>
      <p>
        自然日含首尾；只检测实际已安排任务段，不把项目团队成员推断为全程驻场。不会自动改动其他项目；特殊安排须待真实管理员授权流程。
      </p>
      {conflicts.map((c) => (
        <details key={c.id}>
          <summary>
            {c.person.name} · 重叠 {c.start} — {c.end}
          </summary>
          {[c.a, c.b].map((x) => (
            <p key={x.task.id}>
              {x.project.name} · {x.project.address || '未登记地址/房号'} ·{' '}
              {data.trades.find((g) => g.id === x.task.tradeId)?.name} / {x.task.name} ·{' '}
              {x.task.start} — {x.task.end}
            </p>
          ))}
        </details>
      ))}
    </section>
  );
}
