import { ProjectSurface, useProjectThemeStyles } from './ProjectThemes';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  SlidersHorizontal,
  ArrowDownUp,
  MoreHorizontal,
  CalendarDays,
  RefreshCw,
  Trash2,
  Check,
  Circle,
} from 'lucide-react';
import { cloudApi, CloudError } from '../lib/cloud';
import {
  recordStatuses,
  recordValue,
  recordFields,
  visibleRecords,
  type WorkRecord,
  type RecordValue,
  type RecordHistory,
} from '../lib/records';
import type { Project } from '../lib/model';
import { Modal, Confirm } from './Modal';
import { DateField } from './DateField';
import './record-board.css';

const timestamp = (s: string) =>
  new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const blank = (projectId = ''): RecordValue => ({
  projectId,
  title: '',
  nodeDate: '',
  status: '待执行',
  notes: '',
  followUp: '',
});
const recordData = (r: WorkRecord): RecordValue => ({
  projectId: r.projectId,
  title: r.title,
  nodeDate: r.nodeDate,
  status: r.status,
  notes: r.notes,
  followUp: r.followUp,
});
export function RecordStatus({ status }: { status: string }) {
  return (
    <span className={`status-tag record-status status-${recordStatuses.indexOf(status as any)}`}>
      <Circle size={7} fill="currentColor" />
      {status}
    </span>
  );
}
export function RecordBoard({ projects, isCloud }: { projects: Project[]; isCloud: boolean }) {
  const themeStyle = useProjectThemeStyles();
  const [records, setRecords] = useState<WorkRecord[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [project, setProject] = useState(''),
    [status, setStatus] = useState(''),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState('dateAsc'),
    [group, setGroup] = useState('project'),
    [editor, setEditor] = useState<{ record?: WorkRecord; projectId?: string } | null>(null),
    [confirm, setConfirm] = useState<(() => void) | null>(null);
  const dirty = useRef(false),
    loadSequence = useRef(0),
    mounted = useRef(false);
  const load = useCallback(async () => {
    const seq = ++loadSequence.current;
    try {
      const r = await cloudApi<{ records: WorkRecord[] }>('/records');
      if (!mounted.current || seq !== loadSequence.current) return;
      setRecords(r.records);
      setError('');
    } catch (e) {
      if (mounted.current && seq === loadSequence.current) setError(String(e));
    } finally {
      if (mounted.current && seq === loadSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!isCloud) return;
    mounted.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('chunmo-records-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      ++loadSequence.current;
      window.removeEventListener('chunmo-records-changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [isCloud, load]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);
  const switchEditor = (next: typeof editor) => {
    const run = () => {
      dirty.current = false;
      setEditor(next);
    };
    if (dirty.current) setConfirm(() => run);
    else run();
  };
  useEffect(() => {
    const navigate = (e: Event) => {
      if (!dirty.current) return;
      e.preventDefault();
      const resume = (e as CustomEvent<{ resume: () => void }>).detail.resume;
      setConfirm(() => () => {
        dirty.current = false;
        resume();
      });
    };
    window.addEventListener('chunmo-before-navigation', navigate);
    return () => window.removeEventListener('chunmo-before-navigation', navigate);
  }, []);
  const visible = visibleRecords(records, { project, status, search, sort });
  const projectGroups = [
    ...projects.map((p) => ({ id: p.id, name: p.name, missing: false })),
    ...records
      .filter(
        (r, i, all) =>
          !projects.some((p) => p.id === r.projectId) &&
          all.findIndex((x) => x.projectId === r.projectId) === i,
      )
      .map((r) => ({ id: r.projectId, name: r.projectName + ' · 项目已移除', missing: true })),
  ];
  const columns =
    group === 'status'
      ? recordStatuses
          .filter((s) => !status || status === s)
          .map((s) => ({ id: s, name: s, missing: false }))
      : projectGroups.filter((p) => !project || project === p.id);
  if (!isCloud)
    return (
      <section className="panel board-unavailable">
        <h2>在云端协作中跟进项目</h2>
        <p>
          事项管理由服务器保存并生成真实历史。请登录云端工作空间使用；现有本地项目资料保持不变。
        </p>
      </section>
    );
  return (
    <section className="record-board" aria-label="事项管理">
      <div className="board-tools workbench-toolbar">
        <div className="board-tool-primary">
          <button
            className="primary"
            onClick={() => switchEditor({ projectId: project })}
            disabled={!projects.length}
          >
            <Plus size={16} />
            新增记录
          </button>
          <label className="board-search">
            <Search size={16} />
            <span className="sr-only">搜索看板记录</span>
            <input
              aria-label="搜索看板记录"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索事项、备注或跟进"
            />
          </label>
        </div>
        <div className="board-filters">
          <label>
            <SlidersHorizontal size={14} />
            <span className="sr-only">看板项目筛选</span>
            <select
              aria-label="看板项目筛选"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">全部项目</option>
              {projectGroups.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">看板状态筛选</span>
            <select
              aria-label="看板状态筛选"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              {recordStatuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">看板分组</span>
            <select aria-label="看板分组" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="project">按项目分组</option>
              <option value="status">按状态分组</option>
            </select>
          </label>
          <label>
            <ArrowDownUp size={14} />
            <span className="sr-only">看板排序</span>
            <select aria-label="看板排序" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="dateAsc">节点日期 · 从早到晚</option>
              <option value="dateDesc">节点日期 · 从晚到早</option>
              <option value="updated">最近更新</option>
            </select>
          </label>
        </div>
        <div className="board-tool-meta">
          <span className="board-total">{visible.length} 条记录</span>
          <button className="icon-btn" aria-label="刷新看板" onClick={() => void load()}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {notice && (
        <div role="status" className="board-notice">
          <Check size={15} />
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="error-banner">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      )}
      {loading ? (
        <p className="board-empty" role="status">
          正在读取记录…
        </p>
      ) : !columns.length ? (
        <p className="board-empty">请先在项目工作空间创建项目，再添加跟进记录。</p>
      ) : (
        <div className="board-lanes" tabIndex={0} aria-label="横向滚动项目看板">
          {columns.map((col, i) => {
            const list = visible.filter((r) =>
              group === 'status' ? r.status === col.id : r.projectId === col.id,
            );
            return (
              <ProjectSurface
                role="region"
                projectId={group === 'project' ? col.id : undefined}
                className={`board-lane ${group === 'project' ? 'project-themed-lane' : `tone-${i % 6}`}`}
                key={col.id}
                aria-label={col.name}
              >
                <header className="board-lane-head">
                  <h2 className={group === 'project' ? 'project-context-title' : undefined}>
                    {col.name}
                  </h2>
                  <span className="lane-count" aria-label="记录数量">
                    {list.length}
                  </span>
                  <details className="board-more">
                    <summary aria-label={`${col.name}更多操作`}>
                      <MoreHorizontal size={18} />
                    </summary>
                    <div className="board-menu">
                      <button
                        onClick={(e) => {
                          switchEditor({
                            projectId: group === 'project' && !col.missing ? col.id : project,
                          });
                          e.currentTarget.closest('details')!.open = false;
                        }}
                        disabled={!projects.length || (group === 'project' && col.missing)}
                      >
                        新增记录
                      </button>
                      <button
                        onClick={(e) => {
                          if (group === 'project') setProject(col.id);
                          else setStatus(col.id as any);
                          e.currentTarget.closest('details')!.open = false;
                        }}
                      >
                        仅查看此组
                      </button>
                    </div>
                  </details>
                </header>
                <div className="board-lane-content">
                  {list.length ? (
                    list.map((r) => (
                      <button
                        className="workbench-card record-card"
                        style={themeStyle(r.projectId)}
                        key={r.id}
                        onClick={() => switchEditor({ record: r })}
                        aria-label={`打开记录：${r.title}`}
                      >
                        {group !== 'project' && (
                          <span className="record-project">
                            {projects.find((p) => p.id === r.projectId)?.name ?? r.projectName}
                          </span>
                        )}
                        <h3>{r.title}</h3>
                        <div className="record-card-meta">
                          <span className="record-date">
                            <CalendarDays size={13} />
                            <time>{r.nodeDate || '未设节点日期'}</time>
                          </span>
                          <RecordStatus status={r.status} />
                        </div>
                        {(r.followUp || r.notes) && (
                          <p className="record-summary">{r.followUp || r.notes}</p>
                        )}
                      </button>
                    ))
                  ) : (
                    <p className="lane-empty">暂无记录</p>
                  )}
                </div>
                <button
                  className="board-add"
                  onClick={() =>
                    switchEditor({
                      projectId: group === 'project' && !col.missing ? col.id : project,
                    })
                  }
                  disabled={!projects.length || (group === 'project' && col.missing)}
                  aria-label={`在${col.name}新增记录`}
                >
                  <Plus size={16} />
                  新增记录
                </button>
              </ProjectSurface>
            );
          })}
        </div>
      )}
      {editor && (
        <RecordDrawer
          key={editor.record?.id ?? 'new-' + editor.projectId}
          record={editor.record}
          initialProject={editor.projectId ?? ''}
          projects={projects}
          latest={editor.record ? records.find((r) => r.id === editor.record!.id) : undefined}
          onDirty={(value) => {
            dirty.current = value;
          }}
          onClose={() => switchEditor(null)}
          onSaved={(r) => {
            dirty.current = false;
            setEditor(null);
            setRecords((old) => [...old.filter((x) => x.id !== r.id), ...(r.deleted ? [] : [r])]);
            setNotice(r.deleted ? '记录已删除，操作历史保留。' : '记录已保存。');
            void load();
          }}
        />
      )}
      {confirm && (
        <Confirm
          title="放弃未保存的修改？"
          message="当前记录的草稿尚未保存。确认后关闭草稿，已保存记录不受影响。"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm();
            setConfirm(null);
          }}
        />
      )}
    </section>
  );
}

function RecordDrawer({
  record,
  initialProject,
  projects,
  latest,
  onDirty,
  onClose,
  onSaved,
}: {
  record?: WorkRecord;
  initialProject: string;
  projects: Project[];
  latest?: WorkRecord;
  onDirty: (v: boolean) => void;
  onClose: () => void;
  onSaved: (r: WorkRecord) => void;
}) {
  const [base, setBase] = useState(record),
    [value, setValue] = useState<RecordValue>(() =>
      record ? recordData(record) : blank(initialProject),
    ),
    [tab, setTab] = useState('details'),
    [history, setHistory] = useState<RecordHistory[]>([]),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false),
    [reloadConfirm, setReloadConfirm] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const original = base ? recordData(base) : blank(initialProject);
  const changed = JSON.stringify(value) !== JSON.stringify(original);
  useEffect(() => onDirty(changed), [changed, onDirty]);
  useEffect(() => {
    if (!changed) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [changed]);
  const stale = !!base && (!latest || latest.version !== base.version);
  useEffect(() => {
    if (tab !== 'history' || !base) return;
    let active = true;
    setHistoryBusy(true);
    setHistoryError('');
    void cloudApi<{ events: RecordHistory[] }>(`/records/${encodeURIComponent(base.id)}/history`)
      .then((r) => {
        if (active) setHistory(r.events);
      })
      .catch((e) => {
        if (active) setHistoryError(String(e));
      })
      .finally(() => {
        if (active) setHistoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [tab, base?.id, latest?.version]);
  const change = (key: keyof RecordValue, v: string) => {
    setValue((old) => ({ ...old, [key]: v }));
    setError('');
  };
  async function save(remove = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const parsed = remove ? null : recordValue.parse(value);
      const payload = remove
        ? { version: base!.version }
        : { value: parsed, ...(base ? { version: base.version } : {}) };
      const key = JSON.stringify({ id: base?.id, remove, payload });
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const r = await cloudApi<WorkRecord>(
        base ? `/records/${encodeURIComponent(base.id)}` : '/records',
        remove ? 'DELETE' : base ? 'PUT' : 'POST',
        { ...payload, requestId: request.current.id },
      );
      onSaved(r);
    } catch (e) {
      setError(e instanceof CloudError ? e.message : '请检查任务事项、所属项目及节点日期。');
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title={base ? base.title : '新增记录'}
        subtitle={base ? '项目跟进记录' : '把需要跟进的事项留在项目中'}
        onClose={() => {
          if (!busy) onClose();
        }}
        placement="right"
        className="record-drawer"
      >
        <div className="record-tabs" role="tablist" aria-label="记录详情标签">
          <button
            role="tab"
            id="record-detail-tab"
            aria-controls="record-detail-panel"
            aria-selected={tab === 'details'}
            onClick={() => setTab('details')}
          >
            详情
          </button>
          <button
            role="tab"
            id="record-history-tab"
            aria-controls="record-history-panel"
            aria-selected={tab === 'history'}
            disabled={!base}
            onClick={() => setTab('history')}
          >
            历史
          </button>
        </div>
        <div className="record-drawer-body">
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {stale && (
            <div className="record-stale" role="status">
              此记录已被其他人修改或删除；当前草稿已保留。
              <button disabled={busy} onClick={() => setReloadConfirm(true)}>
                重新读取已保存版本
              </button>
            </div>
          )}
          {tab === 'details' ? (
            <form
              id="record-form"
              role="tabpanel"
              aria-labelledby="record-detail-tab"
              className="record-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                <span>项目</span>
                <select
                  aria-label="记录所属项目"
                  required
                  disabled={!!base || busy}
                  value={value.projectId}
                  onChange={(e) => change('projectId', e.target.value)}
                >
                  <option value="">选择项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {base && !projects.some((p) => p.id === base.projectId) && (
                    <option value={base.projectId}>{base.projectName}（项目已移除）</option>
                  )}
                </select>
              </label>
              <label>
                <span>任务事项</span>
                <textarea
                  aria-label="任务事项"
                  required
                  maxLength={240}
                  rows={2}
                  value={value.title}
                  disabled={busy}
                  onChange={(e) => change('title', e.target.value)}
                  placeholder="需要完成或持续跟进的事项"
                />
              </label>
              <div className="record-field-date">
                <span>节点日期</span>
                <DateField
                  label="记录节点日期"
                  hideLabel
                  value={value.nodeDate}
                  onChange={(v) => {
                    if (!busy) change('nodeDate', v);
                  }}
                />
              </div>
              <label>
                <span>状态</span>
                <select
                  aria-label="记录状态"
                  value={value.status}
                  disabled={busy}
                  onChange={(e) => change('status', e.target.value)}
                >
                  {recordStatuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>备注</span>
                <textarea
                  aria-label="记录备注"
                  rows={4}
                  maxLength={4000}
                  value={value.notes}
                  disabled={busy}
                  onChange={(e) => change('notes', e.target.value)}
                  placeholder="补充现场情况、要求或注意事项"
                />
              </label>
              <label>
                <span>跟进</span>
                <textarea
                  aria-label="记录跟进"
                  rows={4}
                  maxLength={4000}
                  value={value.followUp}
                  disabled={busy}
                  onChange={(e) => change('followUp', e.target.value)}
                  placeholder="记录最新进展与下一步安排"
                />
              </label>
            </form>
          ) : (
            <section
              id="record-history-panel"
              role="tabpanel"
              aria-labelledby="record-history-tab"
              className="record-history"
            >
              {base && (
                <dl className="record-provenance">
                  <div>
                    <dt>创建</dt>
                    <dd>
                      {base.createdName}
                      <time>{timestamp(base.createdAt)}</time>
                    </dd>
                  </div>
                  <div>
                    <dt>最后修改</dt>
                    <dd>
                      {latest?.updatedName ?? base.updatedName}
                      <time>{timestamp(latest?.updatedAt ?? base.updatedAt)}</time>
                    </dd>
                  </div>
                </dl>
              )}
              <p className="record-history-hint">
                操作人、时间与状态由服务端记录。正文仅记录修改字段，避免在历史中重复保留可能包含隐私的内容。
              </p>
              {historyBusy ? (
                <p role="status">正在读取历史…</p>
              ) : historyError ? (
                <p role="alert">{historyError}</p>
              ) : !history.length ? (
                <p>暂无可确认的历史</p>
              ) : (
                <ol>
                  {history.map((h) => (
                    <li key={h.id}>
                      <div>
                        <strong>{h.actorName}</strong>
                        <span>
                          {
                            { create: '创建记录', update: '修改记录', delete: '删除记录' }[
                              h.operation
                            ]
                          }
                        </span>
                      </div>
                      <time>{timestamp(h.at)}</time>
                      <p>{h.changedFields.map((f) => recordFields[f] ?? f).join('、')}</p>
                      {h.before?.status !== h.after?.status && (
                        <p>
                          状态：{h.before?.status ?? '无'} → {h.after?.status ?? '无'}
                        </p>
                      )}
                      {h.before?.nodeDate !== h.after?.nodeDate && (
                        <p>
                          节点日期：{h.before?.nodeDate || '未设置'} →{' '}
                          {h.after?.nodeDate || '未设置'}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
        <footer className="modal-foot record-drawer-foot">
          {base && (
            <button
              className="text-btn destructive"
              onClick={() => setDeleting(true)}
              disabled={busy}
            >
              <Trash2 size={15} />
              删除记录
            </button>
          )}
          <span>{changed ? '有未保存的修改' : base ? '已保存' : '填写后保存'}</span>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="record-form"
            disabled={busy || tab !== 'details' || (!!base && !changed)}
            className="primary"
          >
            {busy ? '正在保存…' : '保存记录'}
          </button>
        </footer>
      </Modal>
      {deleting && (
        <Confirm
          title="删除这条记录？"
          message={`「${base!.title}」将从看板移除，创建信息和操作历史继续保留。此操作不会删除项目、采购或施工任务。`}
          onCancel={() => {
            if (!busy) setDeleting(false);
          }}
          onConfirm={() => void save(true)}
        />
      )}
      {reloadConfirm && (
        <Confirm
          title="重新读取并放弃当前草稿？"
          message="已保存版本将替换当前编辑内容。其他项目及记录不受影响。"
          danger={false}
          onCancel={() => setReloadConfirm(false)}
          onConfirm={() => {
            setReloadConfirm(false);
            if (latest) {
              setBase(latest);
              setValue(recordData(latest));
              setError('');
              request.current = null;
            } else {
              onDirty(false);
              onSaved({ ...base!, deleted: true });
            }
          }}
        />
      )}
    </>
  );
}
