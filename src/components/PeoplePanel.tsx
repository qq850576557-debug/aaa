import { type Data, usedNames } from '../lib/model';
export function PeoplePanel({ data }: { data: Data }) {
  const names = data.nameHistory ?? usedNames(data);
  const rows = [
    ...data.projects.map((p) => ({
      key: `p-${p.id}`,
      project: p.name,
      scope: '项目登记',
      people: p.personnel ?? { worker: '', manager: p.manager, designer: '' },
    })),
    ...data.trades
      .filter((g) => g.personnel)
      .map((g) => ({
        key: `g-${g.id}`,
        project: data.projects.find((p) => p.id === g.projectId)?.name,
        scope: g.name,
        people: g.personnel!,
      })),
    ...data.tasks
      .filter((t) => t.personnel || t.owner)
      .map((t) => ({
        key: `t-${t.id}`,
        project: data.projects.find((p) => p.id === t.projectId)?.name,
        scope: t.name,
        people: t.personnel ?? { worker: t.owner, manager: '', designer: '' },
      })),
  ].filter((r) => Object.values(r.people).some(Boolean));
  return (
    <section className="panel people-panel">
      <h2>人员管理</h2>
      <p>
        当前显示已有项目、工种和任务中的姓名登记。人员档案的新增、编辑、工种归属和分配管理将在后续独立流程实现；当前仍可在项目或施工任务设置中维护原有登记。
      </p>
      <p className="form-info">
        手机号、出生日期等私密资料尚未开放采集。没有真实账号认证与后端权限校验，不能宣称安全权限隔离。
      </p>
      <h3>历史姓名候选 · {names.length}</h3>
      <p>{names.join('、') || '暂无登记'}</p>
      <h3>已有登记关联</h3>
      {rows.map((r) => (
        <article key={r.key} className="people-registration">
          <strong>
            {r.project} / {r.scope}
          </strong>
          <span>
            施工人员：{r.people.worker || '未登记'} · 项目经理：{r.people.manager || '未登记'} ·
            执行设计：{r.people.designer || '未登记'}
          </span>
        </article>
      ))}
      {!rows.length && <p>暂无关联人员登记。</p>}
    </section>
  );
}
