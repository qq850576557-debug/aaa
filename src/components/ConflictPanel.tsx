import { useEffect, useRef } from 'react';
import { staffConflicts, staffAssignmentIssues } from '../lib/readiness';
import type { Data, Task } from '../lib/model';
export function ConflictPanel({
  data,
  projectId,
  onTask,
  pending = false,
  compact = false,
}: {
  data: Data;
  projectId?: string;
  onTask?: (task: Task) => void;
  pending?: boolean;
  compact?: boolean;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) root.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && root.current) root.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  const conflicts = staffConflicts(data).filter(
    (c) => !projectId || c.a.project.id === projectId || c.b.project.id === projectId,
  );
  const issues = compact ? [] : staffAssignmentIssues(data);
  if (!conflicts.length && !issues.length) return null;
  if (compact)
    return conflicts.length || issues.length ? (
      <details ref={root} className="conflict-panel conflict-compact">
        <summary
          title={
            conflicts.length === 1
              ? `${conflicts[0].person.name}｜${conflicts[0].a.project.name} ↔ ${conflicts[0].b.project.name} · ${conflicts[0].start} — ${conflicts[0].end} · ${conflicts[0].days}天`
              : '点击核对人员排班'
          }
        >
          ⚠{' '}
          {conflicts.length === 1
            ? `${conflicts[0].person.name}丨施工日期重叠`
            : conflicts.length
              ? `人员冲突 × ${conflicts.length}`
              : `人员分配待确认 × ${issues.length}`}
        </summary>
        <div className="conflict-popover" role="region" aria-label="人员冲突清单">
          {pending && <p>本地待同步排班预览</p>}
          {issues.map((issue, i) => (
            <p key={i}>
              {issue.sourceName} · {issue.reason}
            </p>
          ))}
          {conflicts.map((c) => (
            <details className="conflict-entry" key={c.id} open={conflicts.length === 1}>
              <summary
                title={`${c.person.name} · ${c.start} — ${c.end} · 重叠${c.days}天 · ${[c.a, c.b].map((x) => data.trades.find((g) => g.id === x.task.tradeId)?.name + ' / ' + x.task.name).join(' ↔ ')}`}
              >
                {c.person.name}｜{c.a.project.name} ↔ {c.b.project.name}
              </summary>
              <div>
                <p>
                  重叠 {c.start} — {c.end} · {c.days}天
                </p>
                {[c.a, c.b].map((x) => (
                  <p key={x.task.id}>
                    {x.project.name} · {data.trades.find((g) => g.id === x.task.tradeId)?.name} /{' '}
                    {x.task.name} · {x.task.start} — {x.task.end}{' '}
                    {onTask && <button onClick={() => onTask(x.task)}>核对任务分配</button>}
                  </p>
                ))}
              </div>
            </details>
          ))}
        </div>
      </details>
    ) : null;
  return (
    <section className="conflict-panel" role="status">
      <h3>{conflicts.length ? `人员档期冲突 · ${conflicts.length}` : '人员分配待确认'}</h3>
      <p>
        自然日含首尾；只检测实际已安排任务段，不把项目团队成员推断为全程驻场。不会自动改动其他项目；特殊安排须待真实管理员授权流程。
      </p>
      {pending && <p>本地待同步排班预览；请以云端确认后的排班为准。</p>}
      {issues.map((x, i) => (
        <p key={i}>
          待确认：{x.sourceName} · {x.reason.replaceAll('人员ID', '人员关联')}
          。原始关联保留，不自动合并。
        </p>
      ))}
      {conflicts.map((c) => (
        <details key={c.id}>
          <summary>
            {c.person.name} · 重叠 {c.start} — {c.end} · {c.days}天
          </summary>
          {[c.a, c.b].map((x) => (
            <p key={x.task.id}>
              {x.project.name} · {data.trades.find((g) => g.id === x.task.tradeId)?.name} /{' '}
              {x.task.name} · {x.task.start} — {x.task.end}
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
