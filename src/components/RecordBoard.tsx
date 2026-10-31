import { ProjectSurface, useProjectThemeStyles } from './ProjectThemes';
import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  SlidersHorizontal,
  ArrowDownUp,
  MoreHorizontal,
  CalendarDays,
  Circle,
  Check,
  RefreshCw,
} from 'lucide-react';
import { RecordDrawer } from './RecordDrawer';
import type { RecordSource } from '../lib/useWorkRecords';
import { recordStatuses, visibleRecords, type WorkRecord } from '../lib/records';
import type { Project } from '../lib/model';
import { Confirm } from './Modal';
import './record-board.css';

export function RecordStatus({ status }: { status: string }) {
  return (
    <span className={`status-tag record-status status-${recordStatuses.indexOf(status as any)}`}>
      <Circle size={7} fill="currentColor" />
      {status}
    </span>
  );
}
export function RecordBoard({
  projects,
  isCloud,
  source,
}: {
  projects: Project[];
  isCloud: boolean;
  source: RecordSource;
}) {
  const { records, loading, error, load, accept } = source;
  const themeStyle = useProjectThemeStyles();
  const [notice, setNotice] = useState(''),
    [project, setProject] = useState(''),
    [status, setStatus] = useState(''),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState('dateAsc'),
    [group, setGroup] = useState('project'),
    [editor, setEditor] = useState<{ record?: WorkRecord; projectId?: string } | null>(null),
    [confirm, setConfirm] = useState<(() => void) | null>(null);
  const dirty = useRef(false);
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
            accept(r);
            setNotice(r.deleted ? '记录已删除，操作历史保留。' : '记录已保存。');
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
