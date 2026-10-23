import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { CalendarDays, GripVertical, MoreHorizontal, Plus, Settings2 } from 'lucide-react';
import {
  days,
  distance,
  duration,
  lanes,
  plus,
  projectRange,
  shortDate,
  today,
  weekday,
  type Data,
  type Project,
  type Task,
  type Trade,
} from '../lib/model';
import type { Anchor } from './Modal';
export const CELL = 56;
const LANE = 48;
interface Props {
  data: Data;
  project: Project;
  onTask: (task?: Task, trade?: Trade, start?: string, end?: string, anchor?: Anchor) => void;
  onDay: (date: string) => void;
  onTrade: (trade?: Trade, index?: number) => void;
  onReorder: (source: string, before: string | null) => void;
  onColor: (trade: Trade, anchor: Anchor) => void;
  onOrder: (trade: Trade, dir: number) => void;
  onMove: (task: Task) => void;
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
  onDay,
  onTrade,
  onOrder,
  onMove,
  onReorder,
  onColor,
}: Props) {
  const [start, end] = projectRange(data, project);
  const dates = days(start, end);
  const trades = data.trades
    .filter((g) => g.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const [draggedTrade, setDraggedTrade] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const taskClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAnchor = useRef<Anchor>({ x: 0, y: 0 });
  const scroller = useRef<HTMLDivElement>(null);
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
      if (taskClick.current) clearTimeout(taskClick.current);
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
    if (taskClick.current) clearTimeout(taskClick.current);
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
      if (taskClick.current) clearTimeout(taskClick.current);
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
        dates.length - 1,
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
        dates[Math.min(r.a, r.b)],
        dates[Math.max(r.a, r.b)],
        lastAnchor.current,
      );
    }
  }
  function jumpToday() {
    const i = distance(start, today());
    if (i >= 0 && i < dates.length)
      scroller.current?.scrollTo({ left: Math.max(0, i * CELL - 200), behavior: 'smooth' });
  }
  const months: { label: string; count: number }[] = [];
  for (const date of dates) {
    const label = `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`;
    if (months.at(-1)?.label === label) months.at(-1)!.count++;
    else months.push({ label, count: 1 });
  }
  return (
    <section className="schedule-section">
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
          <p>双击空白日期或拖选创建 · 拖动时间条调整 · 点击日期查看事项</p>
        </div>
        <div className="toolbar">
          <button onClick={jumpToday} disabled={today() < start || today() > end}>
            今天
          </button>
          <button className="primary" onClick={() => onTask()} disabled={!trades.length}>
            <Plus size={15} />
            施工任务
          </button>
        </div>
      </div>
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
      <div className="gantt-scroll" ref={scroller} data-testid="gantt-scroll">
        <div
          className="gantt"
          style={{ width: `calc(var(--gantt-label) + ${dates.length * CELL}px)` }}
        >
          <div className="month-row">
            <div className="sticky-label month-label">施工工种 / 日期</div>
            <div className="month-cells">
              {months.map((m) => (
                <div key={m.label} style={{ width: m.count * CELL }}>
                  {m.label}
                </div>
              ))}
            </div>
          </div>
          <div className="date-row">
            <div className="sticky-label date-label">
              自然日工期<span>点击日期，管理每日事项</span>
            </div>
            <div className="date-cells">
              {dates.map((date) => {
                const n = data.notes.filter(
                  (n) => n.projectId === project.id && n.date === date && !n.done,
                ).length;
                const p = data.purchases.filter(
                  (p) => p.projectId === project.id && p.status !== '已到货',
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
                    {n > 0 && <i title={`${n} 条待办`} />}
                    {p.length > 0 && <span className="sr-only">可在采购页查看采购安排</span>}
                  </button>
                );
              })}
            </div>
          </div>
          {trades.map((g, index) => {
            const rows = lanes(
              data.tasks.filter((t) => t.projectId === project.id && t.tradeId === g.id),
            );
            const height = Math.max(100, rows.length * LANE + 24);
            return (
              <div
                key={g.id}
                className={`trade-row ${draggedTrade === g.id ? 'sorting' : ''} ${draggedTrade && dropBefore === g.id ? 'drop-before' : ''} ${draggedTrade && dropBefore === null && index === trades.length - 1 ? 'drop-after' : ''}`}
                data-trade-id={g.id}
                style={{ height }}
                onDragOver={(e) => {
                  if (!draggedTrade) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropBefore(
                    e.clientY < r.top + r.height / 2 ? g.id : (trades[index + 1]?.id ?? null),
                  );
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedTrade) onReorder(draggedTrade, dropBefore);
                  setDraggedTrade(null);
                }}
              >
                <div className="sticky-label trade-label">
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
                    <button onClick={() => onTrade(g)} title="编辑工种">
                      {g.name}
                    </button>
                  </div>
                  <div className="trade-meta">
                    <span>
                      {data.tasks
                        .filter((t) => t.tradeId === g.id)
                        .reduce((n, t) => n + duration(t.start, t.end), 0)}{' '}
                      任务天
                    </span>
                    <details className="trade-menu">
                      <summary aria-label={`工种操作${g.name}`}>
                        <MoreHorizontal size={18} />
                      </summary>
                      <div>
                        <button
                          disabled={index === 0}
                          onClick={(e) => {
                            onOrder(g, -1);
                            e.currentTarget.closest('details')?.removeAttribute('open');
                          }}
                        >
                          上移
                        </button>
                        <button
                          disabled={index === trades.length - 1}
                          onClick={(e) => {
                            onOrder(g, 1);
                            e.currentTarget.closest('details')?.removeAttribute('open');
                          }}
                        >
                          下移
                        </button>
                        <button onClick={() => onTrade(g)}>编辑工种</button>
                        <button onClick={() => onTrade(undefined, index + 1)}>
                          在下方新增工种
                        </button>
                      </div>
                    </details>
                    <button
                      className="trade-settings"
                      aria-label={`编辑${g.name}`}
                      onClick={() => onTrade(g)}
                    >
                      <Settings2 size={16} />
                    </button>
                  </div>
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
                    {dates.map((date, i) => (
                      <div
                        key={date}
                        data-date={date}
                        data-index={i}
                        className={`track-cell ${['六', '日'].includes(weekday(date)) ? 'weekend' : ''} ${date === today() ? 'today' : ''}`}
                        onClick={() => pendingDay(date)}
                        onDoubleClick={(e) => {
                          clearClick();
                          if (performance.now() - lastDrag.current > 350)
                            onTask(undefined, g, date, date, { x: e.clientX, y: e.clientY });
                        }}
                      />
                    ))}
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
                    row.map((original) => {
                      const t = drag?.task.id === original.id ? moved(drag) : original;
                      return (
                        <button
                          key={t.id}
                          data-testid="task-bar"
                          title={`${t.name} · ${t.start} — ${t.end}${data.tasks.filter((x) => (x.groupId ?? x.id) === (t.groupId ?? t.id)).length > 1 ? ' · 同任务多段' : ''}`}
                          aria-label={`${t.name}，${t.start} 至 ${t.end}，${duration(t.start, t.end)} 天`}
                          className={`task-bar ${drag?.task.id === t.id ? 'dragging' : ''} ${t.status === '已完成' ? 'completed' : ''} ${t.end < today() && t.status !== '已完成' ? 'overdue' : ''}`}
                          style={{
                            left: distance(start, t.start) * CELL + 4,
                            width: duration(t.start, t.end) * CELL - 8,
                            top: 16 + lane * LANE,
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
                            if (performance.now() - lastDrag.current <= 350) return;
                            if (taskClick.current) clearTimeout(taskClick.current);
                            const anchor = { x: e.clientX, y: e.clientY, element: e.currentTarget };
                            if (e.detail === 0) {
                              onTask(original);
                              return;
                            }
                            taskClick.current = setTimeout(
                              () => onTask(original, undefined, undefined, undefined, anchor),
                              220,
                            );
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            clearClick();
                            if (taskClick.current) clearTimeout(taskClick.current);
                            onTask(original, undefined, undefined, undefined, {
                              x: e.clientX,
                              y: e.clientY,
                            });
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
            <span>拖动工种左侧手柄排序 · 更多菜单提供键盘替代操作</span>
          </div>
        </div>
      </div>
      <div className="gantt-footer">
        <span>
          项目日期：{shortDate(project.start)} — {shortDate(project.end)} ·
          超出计划的任务也会完整展示
        </span>
        <span>手机 / 键盘操作：使用「施工任务」按钮创建，点击时间条编辑日期</span>
      </div>
    </section>
  );
}
