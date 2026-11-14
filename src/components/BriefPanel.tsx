import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './brief-row.css';
const runtimeExpansion = new Map<string, boolean>();
export function BriefPanel({
  title,
  items,
  actions,
  testId,
  className = '',
  emptyText = '暂无',
  date,
  id,
  caption,
  collapseToFirstRow = false,
}: {
  title: string;
  items: ReactNode[];
  actions: ReactNode;
  testId?: string;
  className?: string;
  emptyText?: string;
  date?: string;
  id?: string;
  caption?: string;
  collapseToFirstRow?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() => runtimeExpansion.get(testId || title) ?? true);
  useLayoutEffect(() => {
    const grid = content.current;
    if (!grid || !collapseToFirstRow || expanded || !items.length) return;
    let width = grid.getBoundingClientRect().width;
    let frame = 0;
    const cards = () => Array.from(grid.children) as HTMLElement[];
    const measure = () => {
      frame = 0;
      const nodes = cards();
      // Measure the real, fully laid-out grid before hiding complete later rows.
      // Nothing is clipped, and the visible row keeps its natural card height.
      nodes.forEach((node) => {
        node.hidden = false;
      });
      const firstTop = nodes[0]?.getBoundingClientRect().top;
      if (firstTop === undefined) return;
      const later = nodes.map((node) => node.getBoundingClientRect().top > firstTop + 1);
      nodes.forEach((node, i) => {
        node.hidden = later[i];
      });
      width = grid.getBoundingClientRect().width;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(() => {
      // Height changes caused by hiding rows must not create an observer loop.
      if (Math.abs(grid.getBoundingClientRect().width - width) > 0.1) schedule();
    });
    observer.observe(grid);
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      cards().forEach((node) => {
        node.hidden = false;
      });
    };
  }, [collapseToFirstRow, expanded, items]);
  return (
    <section
      className={`panel workbench-card brief-panel ${expanded ? 'brief-expanded' : ''} ${collapseToFirstRow ? 'brief-first-row' : ''} ${className}`}
      data-testid={testId}
      id={id}
    >
      <header className="brief-heading">
        <h2>
          {title}
          <span className="count"> {items.length}</span>
        </h2>
        <button
          className="brief-toggle"
          aria-label={`${expanded ? '收起' : '展开'}${title}`}
          aria-expanded={expanded}
          onClick={() => {
            if (content.current) content.current.scrollTop = 0;
            setExpanded((v) => {
              runtimeExpansion.set(testId || title, !v);
              return !v;
            });
          }}
        >
          {expanded ? '收起' : '展开'}
        </button>
      </header>
      {(date || caption) && (
        <div className="brief-date">{date ? <time dateTime={date}>{date}</time> : caption}</div>
      )}
      {(expanded || collapseToFirstRow) && (
        <>
          <div className="brief-content" ref={content}>
            {items.length ? items : <p className="brief-empty">{emptyText}</p>}
          </div>
          <footer className="brief-actions">{actions}</footer>
        </>
      )}
    </section>
  );
}
