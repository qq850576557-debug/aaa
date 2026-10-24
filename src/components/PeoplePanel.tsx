import { DictionaryPanel } from './DictionaryPanel';
import { ConflictPanel } from './ConflictPanel';
import { categoryName, tradeNames } from '../lib/dictionaries';
import { staffWork } from '../lib/readiness';
import { useCurrentDate } from '../lib/useCurrentDate';
import { useState, type FormEvent } from 'react';
import { id, personSchema, usedNames, type Data, type Person } from '../lib/model';
import { Confirm, Modal } from './Modal';
export function PeoplePanel({
  data,
  onChange,
}: {
  data: Data;
  onChange: (fn: (d: Data) => Data) => void;
}) {
  const [editing, setEditing] = useState<Person | null>(null),
    [deleting, setDeleting] = useState<Person | null>(null);
  const [assigning, setAssigning] = useState<Person | null>(null),
    [project, setProject] = useState(''),
    [target, setTarget] = useState('project');
  const [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  const [dictionaryOpen, setDictionaryOpen] = useState(false),
    [removeAssignment, setRemoveAssignment] = useState(false);
  const now = useCurrentDate();
  const people = data.people ?? [];
  const names = data.nameHistory ?? usedNames(data);
  const add = (name = '') => {
    setError('');
    setEditing({ id: id(), name, role: '施工人员', trade: '', notes: '', active: true });
  };
  function save(e: FormEvent) {
    e.preventDefault();
    try {
      const p = personSchema.parse(editing);
      onChange((d) => ({
        ...d,
        people: (d.people ?? []).some((x) => x.id === p.id)
          ? d.people!.map((x) => (x.id === p.id ? p : x))
          : [...(d.people ?? []), p],
        nameHistory: [...new Set([...(d.nameHistory ?? usedNames(d)), p.name])].slice(-2000),
      }));
      setEditing(null);
    } catch (e) {
      setError(String(e));
    }
  }
  function assign(e: FormEvent) {
    e.preventDefault();
    try {
      if (!assigning || !project) throw Error('请选择项目');
      onChange((d) => {
        const key =
          target === 'project' ? 'projects' : target.startsWith('trade:') ? 'trades' : 'tasks';
        const entity = target === 'project' ? project : target.slice(target.indexOf(':') + 1);
        const list = d[key];
        if (!list.some((x) => x.id === entity)) throw Error('所选关联已不存在');
        return {
          ...d,
          [key]: list.map((x) =>
            x.id === entity
              ? { ...x, staffIds: [...new Set([...(x.staffIds ?? []), assigning.id])] }
              : x,
          ),
        };
      });
      setAssigning(null);
    } catch (e) {
      setError(String(e));
    }
  }
  const registered = people.filter(
    (p) => !p.deleted && `${p.name}${categoryName(data, p)}${tradeNames(data, p)}`.includes(filter),
  );
  return (
    <section className="panel people-panel">
      <div className="section-heading">
        <div>
          <h2>人员档案</h2>
          <p>统一维护人员，并分配至项目、工种或施工任务。</p>
        </div>
        <button onClick={() => setDictionaryOpen(true)}>类别与工种字典</button>
        <button className="primary" onClick={() => add()}>
          新增人员
        </button>
      </div>
      <p className="form-info">
        手机号、出生日期等私密资料未开放采集。当前没有真实账号认证及服务端授权，不具备安全权限隔离。历史与备份也不采集这些字段。
      </p>
      <label className="form-field">
        搜索人员
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="姓名、类别或工种"
        />
      </label>
      <ConflictPanel data={data} />
      <div className="people-grid">
        {registered.map((p) => (
          <article className="person-card" key={p.id} data-person-id={p.id}>
            <strong>{p.name}</strong>
            <span>
              {categoryName(data, p)} · {tradeNames(data, p) || '未设置工种'} ·{' '}
              {p.active ? '在用' : '已停用'}
            </span>
            <p>{p.notes}</p>
            <details>
              <summary>内部评价</summary>
              <p>
                尚未开放。没有真实账号与服务端授权前不采集或展示内部评价；项目普通备份不含评价。
              </p>
            </details>
            <details className="staff-projects">
              <summary>项目履历 · {staffWork(data, p.id, now).length} 个项目</summary>
              <p>
                {['已完工', '施工中', '未进场']
                  .map(
                    (status) =>
                      `${status} ${staffWork(data, p.id, now).filter((w) => w.status === status).length}`,
                  )
                  .join(' · ')}
              </p>
              {staffWork(data, p.id, now).map((w) => (
                <article key={w.project.id}>
                  <strong>{w.project.name}</strong>
                  <p>
                    {w.project.address} · {w.status}
                  </p>
                  {w.tasks.length ? (
                    w.tasks.map((t) => (
                      <p key={t.id}>
                        {data.trades.find((g) => g.id === t.tradeId)?.name} · {t.name} · 计划进场{' '}
                        {t.start} — 计划结束 {t.end}
                      </p>
                    ))
                  ) : (
                    <p>
                      {w.trades.map((g) => g.name).join('、') || '项目团队'} · 项目计划{' '}
                      {w.project.start} — {w.project.end}（未指定任务段）
                    </p>
                  )}
                </article>
              ))}
            </details>
            <small>
              关联：
              {data.projects
                .filter(
                  (project) =>
                    project.staffIds?.includes(p.id) ||
                    [...data.trades, ...data.tasks].some(
                      (x) => x.projectId === project.id && x.staffIds?.includes(p.id),
                    ),
                )
                .map((p) => p.name)
                .join('、') || '暂无项目'}
            </small>
            <div className="toolbar">
              <button
                onClick={() => {
                  setError('');
                  setEditing(p);
                }}
              >
                编辑人员
              </button>
              <button
                onClick={() =>
                  onChange((d) => ({
                    ...d,
                    people: d.people!.map((x) => (x.id === p.id ? { ...x, active: !x.active } : x)),
                  }))
                }
              >
                {p.active ? '停用' : '启用'}
              </button>
              <button
                disabled={!p.active}
                onClick={() => {
                  setError('');
                  setAssigning(p);
                  setProject(data.projects[0]?.id ?? '');
                  setTarget('project');
                }}
              >
                分配项目／工序
              </button>
              <button className="destructive" onClick={() => setDeleting(p)}>
                删除人员
              </button>
            </div>
          </article>
        ))}
      </div>
      {!registered.length && <p>暂无符合条件的人员档案。</p>}
      <details className="legacy-people">
        <summary>原有登记与历史姓名 · {names.length}</summary>
        <p>旧文字登记不会自动改写。可按原姓名建立正式档案，再分配到项目。</p>
        {names.map((name) => (
          <button
            key={name}
            onClick={() => add(name)}
            disabled={people.some((p) => p.name === name && !p.deleted)}
          >
            用「{name}」建档
          </button>
        ))}
        {[...data.projects, ...data.trades, ...data.tasks]
          .filter((x) => x.personnel || ('owner' in x && x.owner))
          .map((x) => (
            <p key={x.id}>
              {x.name}：
              {Object.values(x.personnel ?? {})
                .filter(Boolean)
                .join('、') || ('owner' in x ? x.owner : '')}
            </p>
          ))}
      </details>
      {dictionaryOpen && (
        <DictionaryPanel data={data} onChange={onChange} onClose={() => setDictionaryOpen(false)} />
      )}
      {removeAssignment && assigning && (
        <Confirm
          title="解除人员分配？"
          message="只移除所选项目/工种/任务的这一位人员；其他项目、其他人员、工期及原有档案保持不变。"
          onCancel={() => setRemoveAssignment(false)}
          onConfirm={() => {
            onChange((d) => {
              const key =
                target === 'project'
                  ? 'projects'
                  : target.startsWith('trade:')
                    ? 'trades'
                    : 'tasks';
              const entity = target === 'project' ? project : target.slice(target.indexOf(':') + 1);
              return {
                ...d,
                [key]: d[key].map((x) =>
                  x.id === entity
                    ? { ...x, staffIds: (x.staffIds ?? []).filter((id) => id !== assigning.id) }
                    : x,
                ),
              };
            });
            setRemoveAssignment(false);
            setAssigning(null);
          }}
        />
      )}
      {editing && (
        <Modal
          title={people.some((x) => x.id === editing.id) ? '编辑人员档案' : '新增人员档案'}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={save}>
            <div className="modal-body form-grid">
              <label>
                姓名
                <input
                  required
                  maxLength={100}
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label>
                工作职责（兼容原角色）
                <select
                  aria-label="工作职责"
                  value={editing.role}
                  onChange={(e) =>
                    setEditing({ ...editing, role: e.target.value as Person['role'] })
                  }
                >
                  {['施工人员', '项目经理', '设计人员', '监理'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                人员类别
                <select
                  aria-label="人员类别"
                  value={editing.categoryId ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, categoryId: e.target.value || undefined })
                  }
                >
                  <option value="">沿用原类别：{editing.role}</option>
                  {data.dictionaries
                    ?.filter(
                      (x) =>
                        x.kind === 'category' &&
                        !x.deleted &&
                        (x.active || x.id === editing.categoryId),
                    )
                    .map((x) => (
                      <option key={x.id} value={x.id} disabled={!x.active}>
                        {x.label}
                        {!x.active ? '（停用）' : ''}
                      </option>
                    ))}
                </select>
              </label>
              <fieldset className="span2">
                <legend>所属工种多选</legend>
                {data.dictionaries
                  ?.filter(
                    (x) =>
                      x.kind === 'trade' &&
                      !x.deleted &&
                      (x.active || editing.tradeIds?.includes(x.id)),
                  )
                  .map((x) => (
                    <label className="check" key={x.id}>
                      <input
                        type="checkbox"
                        aria-label={`人员工种${x.label}`}
                        checked={editing.tradeIds?.includes(x.id) ?? false}
                        disabled={!x.active && !editing.tradeIds?.includes(x.id)}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            tradeIds: e.target.checked
                              ? [...(editing.tradeIds ?? []), x.id]
                              : (editing.tradeIds ?? []).filter((id) => id !== x.id),
                          })
                        }
                      />
                      {x.label}
                      {!x.active ? '（停用）' : ''}
                    </label>
                  ))}
              </fieldset>
              <label>
                原工种文字（兼容保留）
                <input
                  maxLength={100}
                  list="known-trade-names"
                  value={editing.trade}
                  onChange={(e) => setEditing({ ...editing, trade: e.target.value })}
                />
                <datalist id="known-trade-names">
                  {[...new Set(data.trades.map((t) => t.name))].map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </datalist>
              </label>
              <label className="span2">
                人员备注
                <textarea
                  maxLength={4000}
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" type="submit">
                保存
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {assigning && (
        <Modal title={`分配人员 · ${assigning.name}`} onClose={() => setAssigning(null)}>
          <form onSubmit={assign}>
            <div className="modal-body form-grid">
              <label>
                分配项目
                <select
                  required
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setTarget('project');
                  }}
                >
                  <option value="">请选择</option>
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                分配位置
                <select
                  aria-label="分配位置"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="project">项目团队</option>
                  {data.trades
                    .filter((x) => x.projectId === project)
                    .map((x) => (
                      <option key={x.id} value={`trade:${x.id}`}>
                        工种 · {x.name}
                      </option>
                    ))}
                  {data.tasks
                    .filter((x) => x.projectId === project)
                    .map((x) => (
                      <option key={x.id} value={`task:${x.id}`}>
                        任务 · {x.name}
                      </option>
                    ))}
                </select>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setAssigning(null)}>
                取消
              </button>
              <button className="primary" type="submit">
                确认分配
              </button>
              <button type="button" onClick={() => setRemoveAssignment(true)}>
                解除此处分配
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="删除人员档案？"
          message={`「${deleting.name}」将从在用档案和新增分配候选中移除。为保护现有项目与历史，姓名和已有引用将保留，不级联删除施工记录。最近15天内可在全局历史恢复。`}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onChange((d) => ({
              ...d,
              people: d.people!.map((x) =>
                x.id === deleting.id ? { ...x, deleted: true, active: false } : x,
              ),
            }));
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}
