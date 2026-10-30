import { AssessmentPanel } from './AssessmentPanel';
import { ConflictPanel } from './ConflictPanel';
import { categoryName, tradeNames } from '../lib/dictionaries';
import { staffWork } from '../lib/readiness';
import { useCurrentDate } from '../lib/useCurrentDate';
import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ChevronRight,
  Palette,
  UserRound,
  Search,
  GripVertical,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { ColorControls } from './ColorPopover';
import { id, personSchema, usedNames, type Data, type Person } from '../lib/model';
import { Confirm, Modal } from './Modal';
import { WorkerTradePicker } from './WorkerTradePicker';
import { DictionaryPanel } from './DictionaryPanel';
import {
  workerTradeChoices,
  workerCatalog,
  reorderPeople,
  workerTradeColor,
} from '../lib/worker-trades';
import { usePeopleSort } from '../lib/usePeopleSort';
import { useReorderMotion } from '../lib/useReorderMotion';
import './people-trades.css';
export function PeoplePanel({
  data,
  onChange,
  isCloud = false,
}: {
  data: Data;
  isCloud?: boolean;
  onChange: (fn: (d: Data) => Data) => void;
}) {
  const [editing, setEditing] = useState<Person | null>(null),
    [deleting, setDeleting] = useState<Person | null>(null);
  const [assigning, setAssigning] = useState<Person | null>(null),
    [project, setProject] = useState(''),
    [target, setTarget] = useState('project');
  const [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  const [removeAssignment, setRemoveAssignment] = useState(false);
  // Card colors are browser presentation preferences, never workspace or schedule fields.
  const [cardColors, setCardColors] = useState<Record<string, string>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('chunmo-people-card-colors') || '{}');
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([key, color]) =>
                key.length <= 300 && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color),
            ),
          )
        : {};
    } catch {
      return {};
    }
  });
  const [coloring, setColoring] = useState<{
    key: string;
    label: string;
    color: string;
    defaultColor: string;
  } | null>(null);
  const [colorError, setColorError] = useState('');
  const now = useCurrentDate();
  const people = data.people ?? [];
  const names = data.nameHistory ?? usedNames(data);
  const [manageTrades, setManageTrades] = useState(false);
  const tradeOptions = workerTradeChoices(data);
  const grid = useRef<HTMLDivElement>(null);
  const sort = usePeopleSort(grid, (source, before) => {
    try {
      onChange((d) => reorderPeople(d, source, before));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  });
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
        dictionaries: [
          ...(d.dictionaries ?? []),
          ...workerCatalog(d).filter(
            (x) =>
              p.tradeIds?.includes(x.id) && !(d.dictionaries ?? []).some((old) => old.id === x.id),
          ),
        ],
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
  useReorderMotion(grid, '.person-card[data-person-id]', registered.map((p) => p.id).join('|'));
  const tradesFor = (person: Person) =>
    person.tradeIds?.length
      ? [
          ...new Map(
            person.tradeIds.map((key) => {
              const group = tradeOptions.find((x) => x.ids.includes(key));
              return [
                group?.id || key,
                {
                  key: 'id:' + (group?.id || key),
                  label: group?.label || data.dictionaries?.find((x) => x.id === key)?.label || key,
                },
              ];
            }),
          ).values(),
        ]
      : [{ key: 'name:' + person.trade, label: person.trade || '未设置工种' }];
  const cardTrades = [
    ...new Map(
      people
        .filter((x) => !x.deleted)
        .flatMap(tradesFor)
        .map((x) => [x.key, x]),
    ).values(),
  ];
  const defaultCardColor = (_key: string, label: string) => workerTradeColor(label);
  const openColor = (key = cardTrades[0]?.key) => {
    const trade = cardTrades.find((x) => x.key === key);
    if (!trade) return;
    const defaultColor = defaultCardColor(trade.key, trade.label);
    setColorError('');
    setColoring({ ...trade, defaultColor, color: cardColors[trade.key] || defaultColor });
  };
  return (
    <section className="panel people-panel">
      <div className="section-heading">
        <h2>人员档案</h2>
        <label className="people-search">
          <Search size={16} />
          <input
            aria-label="搜索人员"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="姓名、类别或工种"
          />
        </label>
        <div className="toolbar">
          <button onClick={() => setManageTrades(true)}>工种管理</button>
          <button onClick={() => openColor()} disabled={!cardTrades.length}>
            <Palette size={15} />
            工种配色
          </button>
          <button className="primary" onClick={() => add()}>
            新增人员
          </button>
        </div>
      </div>
      <p className="form-info">
        手机号、出生日期等私密资料未开放采集。云端私密 API
        由服务端授权；本地资料不具备账号权限隔离。历史与普通备份不含这些字段。
      </p>
      {error && !editing && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <AssessmentPanel data={data} isCloud={isCloud} />
      <ConflictPanel data={data} />
      <div className="people-grid" ref={grid}>
        {registered.map((p, index) => {
          const trades = tradesFor(p),
            first = trades[0];
          const color = cardColors[first.key] || defaultCardColor(first.key, first.label);
          return (
            <article
              className={`person-card ${sort.source === p.id ? 'sorting' : ''} ${sort.source && sort.marker?.target === p.id && p.id !== sort.source ? 'person-drop-' + sort.marker.edge + (sort.marker.vertical ? ' person-drop-vertical' : '') : ''}`}
              key={p.id}
              data-person-id={p.id}
              style={{ '--person-color': color } as CSSProperties}
            >
              <div className="person-sort-toolbar" role="group" aria-label={`排序人员${p.name}`}>
                <button
                  className="person-sort-handle"
                  aria-label={`拖动人员${p.name}`}
                  title="拖动排序；也可按 Alt + 上下方向键"
                  onPointerDown={(e) => sort.start(e, p.id)}
                  onPointerMove={sort.move}
                  onPointerUp={sort.end}
                  onPointerCancel={sort.cancel}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                      e.preventDefault();
                      const i = e.key === 'ArrowUp' ? index - 1 : index + 2;
                      if (
                        (e.key === 'ArrowUp' && index > 0) ||
                        (e.key === 'ArrowDown' && index < registered.length - 1)
                      ) {
                        try {
                          onChange((d) => reorderPeople(d, p.id, registered[i]?.id ?? null));
                        } catch (err) {
                          setError(String(err));
                        }
                      }
                    }
                  }}
                >
                  <GripVertical size={16} />
                </button>
                <button
                  aria-label={`上移人员${p.name}`}
                  disabled={index === 0}
                  onClick={() => {
                    try {
                      onChange((d) => reorderPeople(d, p.id, registered[index - 1].id));
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  aria-label={`下移人员${p.name}`}
                  disabled={index === registered.length - 1}
                  onClick={() => {
                    try {
                      onChange((d) => reorderPeople(d, p.id, registered[index + 2]?.id ?? null));
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <ArrowDown size={14} />
                </button>
              </div>
              <button
                className="person-card-open"
                aria-label={`打开人员档案：${p.name}`}
                onClick={() => {
                  setError('');
                  setEditing(p);
                }}
              >
                <span className="person-card-symbol" aria-hidden="true">
                  <UserRound size={21} />
                </span>
                <span>
                  <strong>{p.name}</strong>
                  <small>{categoryName(data, p)}</small>
                </span>
                <ChevronRight size={17} />
              </button>
              <div className="person-trade-tags">
                {trades.map((trade) => (
                  <span
                    key={trade.key}
                    style={
                      {
                        '--person-color':
                          cardColors[trade.key] || defaultCardColor(trade.key, trade.label),
                      } as CSSProperties
                    }
                  >
                    {trade.label}
                  </span>
                ))}
              </div>
              {!p.active && <small className="person-inactive">暂不参与新分配</small>}
              {p.notes && <p>{p.notes}</p>}
              <details>
                <summary>内部评价</summary>
                <p>
                  尚未开放。没有真实账号与服务端授权前不采集或展示内部评价；项目普通备份不含评价。
                </p>
              </details>
              <details className="staff-projects">
                <summary>项目履历 · {staffWork(data, p.id, now).length} 个项目</summary>
                <ul className="staff-project-names">
                  {staffWork(data, p.id, now).map((w) => (
                    <li key={w.project.id}>{w.project.name}</li>
                  ))}
                </ul>
                <button
                  disabled={!p.active}
                  onClick={() => {
                    setError('');
                    setAssigning(p);
                    setProject(data.projects[0]?.id ?? '');
                    setTarget('project');
                  }}
                >
                  管理项目分配
                </button>
              </details>
              <div className="toolbar">
                <button
                  onClick={() => {
                    setError('');
                    setEditing(p);
                  }}
                >
                  编辑人员
                </button>
                <button className="destructive" onClick={() => setDeleting(p)}>
                  删除人员
                </button>
              </div>
            </article>
          );
        })}
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
      {coloring && (
        <Modal
          title="工种卡片配色"
          subtitle="仅调整当前浏览器的人员卡片外观"
          className="people-color-dialog"
          onClose={() => setColoring(null)}
        >
          <div className="modal-body">
            <label className="form-field">
              选择工种
              <select
                aria-label="卡片配色工种"
                value={coloring.key}
                onChange={(e) => openColor(e.target.value)}
              >
                {cardTrades.map((trade) => (
                  <option key={trade.key} value={trade.key}>
                    {trade.label}
                  </option>
                ))}
              </select>
            </label>
            <ColorControls
              compact
              color={coloring.color}
              defaultColor={coloring.defaultColor}
              recent={[]}
              onChange={(color) => setColoring({ ...coloring, color })}
            />
            {colorError && (
              <p role="alert" className="error">
                {colorError}
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setColoring(null)}>取消</button>
            <button
              className="primary"
              disabled={!/^#[0-9a-f]{6}$/i.test(coloring.color)}
              onClick={() => {
                const next = { ...cardColors, [coloring.key]: coloring.color };
                try {
                  localStorage.setItem('chunmo-people-card-colors', JSON.stringify(next));
                  setCardColors(next);
                  setColoring(null);
                } catch {
                  setColorError('浏览器未能保存配色，请检查存储权限后重试。');
                }
              }}
            >
              保存配色
            </button>
          </footer>
        </Modal>
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
              <WorkerTradePicker
                data={data}
                value={editing.tradeIds ?? []}
                onChange={(tradeIds) => setEditing({ ...editing, tradeIds })}
                onManage={() => setManageTrades(true)}
              />
              <label className="check span2">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                可参与新分配
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
      {manageTrades && (
        <DictionaryPanel data={data} onChange={onChange} onClose={() => setManageTrades(false)} />
      )}
    </section>
  );
}
