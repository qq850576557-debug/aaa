import { timelineRange, timelineWindow } from '../lib/timeline';
import { assignedNames } from '../lib/people';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { CalendarDays, GripVertical, Plus } from 'lucide-react';
import {
  days,
  distance,
  duration,
  lanes,
  plus,
  purchaseDue,
  purchaseComplete,
  shortDate,
  today,
  weekday,
  type Data,
  type Project,
  type Task,
  type Trade,
} from '../lib/model';
import { TaskContextMenu } from './TaskContextMenu';
import type { Anchor } from './Modal';
import { useReorderMotion } from '../lib/useReorderMotion';
export const CELL = 56;
const LANE = 40;
interface Props {
  data: Data;
  project: Project;
  onTask: (task?: Task, trade?: Trade, start?: string, end?: string, anchor?: Anchor) => void;
  onDay: (date: string) => void;
  onQuickCreate: (trade: Trade, date: string) => void;
  onTrade: (trade?: Trade, index?: number) => void;
  onReorder: (source: string, before: string | null) => void;
  onColor: (trade: Trade, anchor: Anchor) => void;
  onOrder: (trade: Trade, dir: number) => void;
  onMove: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onExport: () => void;
}
type Drag = {
  task: Task;
  mode: 'move' | 'start' | 'end';
  x: number;
  scroll: number;
  delta: number;
  dayWidth: number;
};
export function Gantt({
  data,
  project,
  onTask,
  onQuickCreate,
  onDay,
  onTrade,
  onOrder,
  onMove,
  onDeleteTask,
  onExport,
  onReorder,
  onColor,
}: Props) {
  const [touchLayout, setTouchLayout] = useState(
    () => window.matchMedia('(max-width: 700px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const update = () => setTouchLayout(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const laneHeight = touchLayout ? 48 : LANE;
  const [start, end] = timelineRange(data, project);
  const total = duration(start, end);
  const [visible, setVisible] = useState({ first: 0, last: 30 });
  const first = Math.min(visible.first, total - 1),
    last = Math.min(total, Math.max(visible.last, first + 1));
  const dates = useMemo(
    () => days(plus(start, first), plus(start, last - 1)),
    [start, first, last],
  );
  const viewedDate = useRef<string | null>(null);
  const rangeKey = useRef('');
  const trades = data.trades
    .filter((g) => g.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const [draggedTrade, setDraggedTrade] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const touchOrder = useRef<{
    id: string;
    before: string | null;
    y: number;
    moved: boolean;
  } | null>(null);
  const lastAnchor = useRef<Anchor>({ x: 0, y: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  function updateWindow() {
    const el = scroller.current;
    if (!el) return;
    viewedDate.current = plus(
      start,
      Math.max(0, Math.min(total - 1, Math.floor(el.scrollLeft / CELL))),
    );
    const next = timelineWindow(el.scrollLeft, el.clientWidth, total);
    setVisible((prev) => (prev.first === next.first && prev.last === next.last ? prev : next));
  }
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const key = project.id + ':' + start;
    if (rangeKey.current !== key) {
      const target =
        viewedDate.current && viewedDate.current >= start && viewedDate.current <= end
          ? viewedDate.current
          : today();
      el.scrollLeft = Math.max(0, distance(start, target) * CELL - (viewedDate.current ? 0 : CELL));
      rangeKey.current = key;
    }
    updateWindow();
    const observer = new ResizeObserver(updateWindow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [project.id, start, end]);
  useReorderMotion(scroller, '.trade-row', trades.map((g) => g.id).join('|'));
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = useRef<Drag | null>(null);
  const lastDrag = useRef(-Infinity);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [range, setRange] = useState<{
    trade: string;
    a: number;
    b: number;
    x: number;
    scroll: number;
    dayWidth: number;
  } | null>(null);
  const selecting = useRef<typeof range>(null);
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );
  const pendingDay = (date: string) => {
    if (performance.now() - lastDrag.current < 350) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => onDay(date), 260);
  };
  const clearClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
  };
  function barDown(e: PointerEvent, task: Task, mode: Drag['mode']) {
    if (e.button !== 0) return;
    e.stopPropagation();
    clearClick();
    lastAnchor.current = { x: e.clientX, y: e.clientY, element: e.currentTarget as HTMLElement };
    e.currentTarget.setPointerCapture(e.pointerId);
    const d = {
      task,
      mode,
      x: e.clientX,
      scroll: scroller.current!.scrollLeft,
      delta: 0,
      dayWidth: scroller.current!.querySelector('.date-cell')!.getBoundingClientRect().width,
    };
    dragging.current = d;
    setDrag(d);
  }
  function moved(d: Drag): Task {
    const t = d.task;
    let delta = d.delta;
    if (d.mode === 'start') delta = Math.min(delta, distance(t.start, t.end));
    if (d.mode === 'end') delta = Math.max(delta, -distance(t.start, t.end));
    return {
      ...t,
      start: d.mode === 'end' ? t.start : plus(t.start, delta),
      end: d.mode === 'start' ? t.end : plus(t.end, delta),
    };
  }
  function barMove(e: PointerEvent) {
    const d = dragging.current;
    if (!d) return;
    const delta = Math.round(
      (e.clientX - d.x) / d.dayWidth + (scroller.current!.scrollLeft - d.scroll) / CELL,
    );
    dragging.current = { ...d, delta };
    setDrag(dragging.current);
  }
  function barUp(e: PointerEvent) {
    if (!dragging.current) return;
    e.stopPropagation();
    const d = dragging.current;
    dragging.current = null;
    setDrag(null);
    if (d.delta) {
      lastDrag.current = performance.now();
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      onMove(moved(d));
    }
  }
  function rowDown(e: PointerEvent, g: Trade) {
    if (
      e.button !== 0 ||
      e.pointerType === 'touch' ||
      !(e.target as HTMLElement).hasAttribute('data-date')
    )
      return;
    clearClick();
    lastAnchor.current = { x: e.clientX, y: e.clientY, element: e.currentTarget as HTMLElement };
    const a = Number((e.target as HTMLElement).dataset.index);
    const r = {
      trade: g.id,
      a,
      b: a,
      x: e.clientX,
      scroll: scroller.current!.scrollLeft,
      dayWidth: scroller.current!.querySelector('.date-cell')!.getBoundingClientRect().width,
    };
    selecting.current = r;
    setRange(r);
  }
  function rowMove(e: PointerEvent) {
    const r = selecting.current;
    if (!r) return;
    const b = Math.max(
      0,
      Math.min(
        total - 1,
        r.a +
          Math.round(
            (e.clientX - r.x) / r.dayWidth + (scroller.current!.scrollLeft - r.scroll) / CELL,
          ),
      ),
    );
    if (b !== r.a && !e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.setPointerCapture(e.pointerId);
    selecting.current = { ...r, b };
    setRange(selecting.current);
  }
  function rowUp() {
    const r = selecting.current;
    selecting.current = null;
    setRange(null);
    if (r && r.a !== r.b) {
      clearClick();
      lastDrag.current = performance.now();
      onTask(
        undefined,
        trades.find((g) => g.id === r.trade),
        plus(start, Math.min(r.a, r.b)),
        plus(start, Math.max(r.a, r.b)),
        lastAnchor.current,
      );
    }
  }
  function jumpToday() {
    const i = distance(start, today());
    if (i >= 0 && i < total)
      scroller.current?.scrollTo({ left: Math.max(0, i * CELL - 200), behavior: 'smooth' });
  }
  const months: { label: string; count: number }[] = [];
  for (const date of dates) {
    const label = `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`;
    if (months.at(-1)?.label === label) months.at(-1)!.count++;
    else months.push({ label, count: 1 });
  }
  return (
    <section className="schedule-section" id="project-timeline">
      <div className="section-heading">
        <div>
          <h2>
            <CalendarDays size={20} />
            施工工期{' '}
            <span className="count">
              {trades.length} 个工种 · {data.tasks.filter((t) => t.projectId === project.id).length}{' '}
              段任务
            </span>
          </h2>
          <p>双击空白日期直接新增施工任务 · 拖选创建施工任务 · 拖动时间条调整</p>
        </div>
        <div className="toolbar">
          <label className="timeline-jump">
            定位日期
            <input
              aria-label="定位日期"
              type="date"
              min={start}
              max={end}
              onChange={(e) => {
                if (e.target.value >= start && e.target.value <= end)
                  scroller.current?.scrollTo({
                    left: distance(start, e.target.value) * CELL,
                    behavior: 'auto',
                  });
              }}
            />
          </label>
          <button onClick={onExport}>导出施工工期长图</button>
          <button onClick={jumpToday} disabled={today() < start || today() > end}>
            今天
          </button>
          <button className="primary" onClick={() => onTask()} disabled={!trades.length}>
            <Plus size={15} />
            施工任务
          </button>
        </div>
      </div>
      <p className="today-construction">
        今日施工：
        {data.tasks
          .filter(
            (t) =>
              t.projectId === project.id &&
              t.status !== '已完成' &&
              t.start <= today() &&
              t.end >= today(),
          )
          .map((t) => `${trades.find((g) => g.id === t.tradeId)?.name ?? ''} · ${t.name}`)
          .join('；') || '暂无排期'}
      </p>
      <div className="legend">
        {trades.map((g) => (
          <button
            key={g.id}
            onClick={(e) => onColor(g, { x: e.clientX, y: e.clientY, element: e.currentTarget })}
          >
            <i style={{ background: g.color }} />
            {g.name}
          </button>
        ))}
      </div>
      <div
        className="gantt-scroll"
        ref={scroller}
        onScroll={updateWindow}
        data-testid="gantt-scroll"
        data-range-start={start}
        data-range-end={end}
      >
        <div className="gantt" style={{ width: `calc(var(--gantt-label) + ${total * CELL}px)` }}>
          <div className="month-row">
            <div className="sticky-label month-label">施工工种 / 日期</div>
            <div className="month-cells">
              <div className="timeline-spacer" style={{ width: first * CELL }} />
              {months.map((m) => (
                <div key={m.label} style={{ width: m.count * CELL }}>
                  {m.label}
                </div>
              ))}
              <div className="timeline-spacer" style={{ width: (total - last) * CELL }} />
            </div>
          </div>
          <div className="date-row">
            <div className="sticky-label date-label">
              自然日工期<span>点击日期，管理每日事项</span>
            </div>
            <div className="date-cells">
              <div className="timeline-spacer" style={{ width: first * CELL }} />
              {dates.map((date) => {
                const n = data.notes.filter(
                  (n) => n.projectId === project.id && n.date === date && !n.done,
                ).length;
                const p = data.purchases.filter(
                  (p) =>
                    p.projectId === project.id &&
                    !purchaseComplete(p) &&
                    purchaseDue(p, data) === date,
                );
                return (
                  <button
                    key={date}
                    aria-label={`查看 ${date} 事项`}
                    className={`date-cell ${['六', '日'].includes(weekday(date)) ? 'weekend' : ''} ${date === today() ? 'today' : ''}`}
                    onClick={() => onDay(date)}
                  >
                    <strong>{Number(date.slice(8))}</strong>
                    <span>周{weekday(date)}</span>
                    {n + p.length > 0 && (
                      <i title={`${n + p.length} 条待办（采购 ${p.length} 条）`} />
                    )}
                    {p.length > 0 && <span className="sr-only">{p.length} 条采购到期</span>}
                  </button>
                );
              })}
              <div className="timeline-spacer" style={{ width: (total - last) * CELL }} />
            </div>
          </div>
          {trades.map((g, index) => {
            const rows = lanes(
              data.tasks.filter((t) => t.projectId === project.id && t.tradeId === g.id),
            );
            const height = Math.max(touchLayout ? 124 : 84, rows.length * laneHeight + 20);
            return (
              <div
                key={g.id}
                className={`trade-row ${draggedTrade === g.id ? 'sorting' : ''} ${draggedTrade && dropBefore === g.id ? 'drop-before' : ''} ${draggedTrade && dropBefore === null && index === trades.length - 1 ? 'drop-after' : ''}`}
                data-trade-id={g.id}
                style={{ height }}
                onDragOver={(e) => {
                  if (!draggedTrade) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropBefore(
                    e.clientY < r.top + r.height / 2 ? g.id : (trades[index + 1]?.id ?? null),
                  );
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const source = e.dataTransfer.getData('text/plain');
                  const r = e.currentTarget.getBoundingClientRect();
                  const target =
                    e.clientY < r.top + r.height / 2 ? g.id : (trades[index + 1]?.id ?? null);
                  if (source === draggedTrade) onReorder(source, target);
                  setDraggedTrade(null);
                }}
              >
                <div
                  className="sticky-label trade-label"
                  draggable
                  onDragStart={(e) => {
                    if ((e.target as HTMLElement).closest('button:not(.drag-handle), summary')) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.setData('text/plain', g.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggedTrade(g.id);
                  }}
                  onDragEnd={() => {
                    setDraggedTrade(null);
                    setDropBefore(null);
                  }}
                >
                  <button
                    className="insert-trade"
                    aria-label={`在${g.name}前新增工种`}
                    onClick={() => onTrade(undefined, index)}
                  >
                    <Plus size={14} />
                  </button>
                  <div className="trade-title">
                    <button
                      className="drag-handle"
                      draggable
                      aria-label={`拖动工种${g.name}`}
                      title="拖放排序；也可按 Alt + 上下方向键"
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', g.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggedTrade(g.id);
                      }}
                      onDragEnd={() => setDraggedTrade(null)}
                      onPointerDown={(e) => {
                        if (e.pointerType !== 'touch') return;
                        e.preventDefault();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        touchOrder.current = { id: g.id, before: g.id, y: e.clientY, moved: false };
                      }}
                      onPointerMove={(e) => {
                        const d = touchOrder.current;
                        if (!d) return;
                        if (Math.abs(e.clientY - d.y) < 5 && !d.moved) return;
                        d.moved = true;
                        const row = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest('.trade-row');
                        if (row) {
                          const target = row.getAttribute('data-trade-id')!;
                          const i = trades.findIndex((t) => t.id === target);
                          const r = row.getBoundingClientRect();
                          d.before =
                            e.clientY < r.top + r.height / 2 ? target : (trades[i + 1]?.id ?? null);
                          setDraggedTrade(d.id);
                          setDropBefore(d.before);
                        }
                      }}
                      onPointerUp={() => {
                        const d = touchOrder.current;
                        touchOrder.current = null;
                        if (d?.moved) onReorder(d.id, d.before);
                        setDraggedTrade(null);
                        setDropBefore(null);
                      }}
                      onPointerCancel={() => {
                        if (!touchOrder.current) return;
                        touchOrder.current = null;
                        setDraggedTrade(null);
                        setDropBefore(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                          e.preventDefault();
                          onOrder(g, e.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                    >
                      <GripVertical size={17} />
                    </button>
                    <button
                      className="trade-color"
                      aria-label={`设置${g.name}颜色`}
                      style={{ background: g.color }}
                      onClick={(e) =>
                        onColor(g, { x: e.clientX, y: e.clientY, element: e.currentTarget })
                      }
                    />
                    <button
                      aria-label={`编辑${g.name}`}
                      onClick={() => onTrade(g)}
                      title="编辑工种"
                    >
                      <span>{g.name}</span>
                      <small>
                        {data.tasks
                          .filter((t) => t.tradeId === g.id)
                          .reduce((n, t) => n + duration(t.start, t.end), 0)}{' '}
                        任务天
                      </small>
                    </button>
                  </div>
                  <button
                    className="trade-workers"
                    aria-label={`安排${g.name}施工人员`}
                    title={assignedNames(data, g, '施工人员') || '未安排'}
                    onClick={() => onTrade(g)}
                  >
                    师傅：{assignedNames(data, g, '施工人员') || '未安排'}
                  </button>
                </div>
                <div
                  className="track"
                  onPointerDown={(e) => rowDown(e, g)}
                  onPointerMove={rowMove}
                  onPointerUp={rowUp}
                  onPointerCancel={() => {
                    selecting.current = null;
                    setRange(null);
                  }}
                >
                  <div className="track-cells">
                    <div className="timeline-spacer" style={{ width: first * CELL }} />
                    {dates.map((date, i) => (
                      <div
                        key={date}
                        data-date={date}
                        data-index={i + first}
                        className={`track-cell ${['六', '日'].includes(weekday(date)) ? 'weekend' : ''} ${date === today() ? 'today' : ''}`}
                        onClick={() => pendingDay(date)}
                        onDoubleClick={() => {
                          clearClick();
                          if (performance.now() - lastDrag.current > 350) onQuickCreate(g, date);
                        }}
                      />
                    ))}
                    <div className="timeline-spacer" style={{ width: (total - last) * CELL }} />
                  </div>
                  {range?.trade === g.id && range.a !== range.b && (
                    <div
                      className="range-preview"
                      style={{
                        left: Math.min(range.a, range.b) * CELL,
                        width: (Math.abs(range.b - range.a) + 1) * CELL,
                        height,
                      }}
                    />
                  )}
                  {rows.map((row, lane) =>
                    row
                      .filter(
                        (t) => t.end >= plus(start, first) && t.start <= plus(start, last - 1),
                      )
                      .map((original) => {
                        const t = drag?.task.id === original.id ? moved(drag) : original;
                        return (
                          <button
                            key={t.id}
                            data-testid="task-bar"
                            data-task-id={t.id}
                            title={`${t.name} · ${t.start} — ${t.end}${data.tasks.filter((x) => (x.groupId ?? x.id) === (t.groupId ?? t.id)).length > 1 ? ' · 同任务多段' : ''}`}
                            aria-label={`${t.name}，${t.start} 至 ${t.end}，${duration(t.start, t.end)} 天`}
                            className={`task-bar ${drag?.task.id === t.id ? 'dragging' : ''} ${t.status === '已完成' ? 'completed' : ''} ${t.start <= today() && t.end >= today() && t.status !== '已完成' ? 'working-today' : ''} ${t.end < today() && t.status !== '已完成' ? 'overdue' : ''}`}
                            style={{
                              left: distance(start, t.start) * CELL + 4,
                              width: duration(t.start, t.end) * CELL - 8,
                              top:
                                (height - rows.length * laneHeight) / 2 +
                                (touchLayout ? 2 : 7) +
                                lane * laneHeight,
                              background: `${g.color}26`,
                              borderColor: g.color,
                              color: '#273c34',
                            }}
                            onPointerDown={(e) => barDown(e, original, 'move')}
                            onPointerMove={barMove}
                            onPointerUp={barUp}
                            onPointerCancel={() => {
                              dragging.current = null;
                              setDrag(null);
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (e.detail === 0) {
                                const r = e.currentTarget.getBoundingClientRect();
                                setMenu({ id: original.id, x: r.left, y: r.bottom });
                              }
                            }}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              clearClick();
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              clearClick();
                              setMenu({ id: original.id, x: e.clientX, y: e.clientY });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                                e.preventDefault();
                                const r = e.currentTarget.getBoundingClientRect();
                                setMenu({ id: original.id, x: r.left, y: r.bottom });
                              }
                            }}
                          >
                            <span
                              className="resize-handle left"
                              data-testid="resize-start"
                              onPointerDown={(e) => barDown(e, original, 'start')}
                              title="拖动调整开始日期"
                            />
                            <span className="bar-title">
                              {data.tasks.filter(
                                (x) =>
                                  x.projectId === t.projectId &&
                                  (x.groupId ?? x.id) === (t.groupId ?? t.id),
                              ).length > 1
                                ? '↔ '
                                : ''}
                              {t.status === '已完成' ? '✓ ' : ''}
                              {t.name}
                            </span>
                            {duration(t.start, t.end) > 2 && (
                              <span className="bar-duration">{duration(t.start, t.end)}天</span>
                            )}
                            {drag?.task.id === t.id && (
                              <span className="drag-dates">
                                {t.start} — {t.end}
                              </span>
                            )}
                            <span
                              className="resize-handle right"
                              data-testid="resize-end"
                              onPointerDown={(e) => barDown(e, original, 'end')}
                              title="拖动调整结束日期"
                            />
                          </button>
                        );
                      }),
                  )}
                </div>
              </div>
            );
          })}
          <div className="trade-list-add">
            <button onClick={() => onTrade(undefined, trades.length)}>
              <Plus size={17} />
              在列表末尾新增工种
            </button>
            <span>拖动左侧手柄排序 · 触屏拖动或 Alt + 方向键调整</span>
          </div>
        </div>
      </div>
      <div className="gantt-footer">
        <span>
          项目日期：{shortDate(project.start)} — {shortDate(project.end)} ·
          超出计划的任务也会完整展示
        </span>
        <span>拖动时间条及两端调整 · 右键操作 · 手机 / 键盘可使用下方任务详情入口</span>
      </div>
      <details className="task-details-list">
        <summary>任务详情与多段管理</summary>
        {data.tasks
          .filter((t) => t.projectId === project.id)
          .map((t) => (
            <button key={t.id} aria-label={`编辑任务${t.name}`} onClick={() => onTask(t)}>
              {t.name} · {t.start} — {t.end} · {t.status}
            </button>
          ))}
        {!data.tasks.some((t) => t.projectId === project.id) && (
          <p>暂无施工任务，请使用施工任务入口或拖选日期创建。</p>
        )}
      </details>
      {menu && data.tasks.find((t) => t.id === menu.id) && (
        <TaskContextMenu
          task={data.tasks.find((t) => t.id === menu.id)!}
          point={menu}
          onClose={() => setMenu(null)}
          onEdit={() =>
            onTask(
              data.tasks.find((t) => t.id === menu.id)!,
              undefined,
              undefined,
              undefined,
              { x: menu.x, y: menu.y },
            )
          }
          onDelete={() => onDeleteTask(data.tasks.find((t) => t.id === menu.id)!)}
        />
      )}
    </section>
  );
}
