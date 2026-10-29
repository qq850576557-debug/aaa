import { useRef, useState, type ReactNode } from 'react';
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
}) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  return (
    <section
      className={`panel workbench-card brief-panel ${expanded ? 'brief-expanded' : ''} ${className}`}
      data-testid={testId}
      id={id}
    >
      <header className="brief-heading">
        <h2>
          {title}
          {items.length > 0 && <span className="count"> {items.length}</span>}
        </h2>
        <button
          className="brief-toggle"
          aria-label={`${expanded ? '收起' : '展开'}${title}`}
          aria-expanded={expanded}
          disabled={!items.length}
          onClick={() => {
            if (content.current) content.current.scrollTop = 0;
            setExpanded((v) => !v);
          }}
        >
          {expanded ? '收起' : '展开'}
        </button>
      </header>
      {(date || caption) && (
        <div className="brief-date">{date ? <time dateTime={date}>{date}</time> : caption}</div>
      )}
      <div className="brief-content" ref={content}>
        {items.length ? (
          expanded ? (
            items
          ) : (
            items.slice(0, 3)
          )
        ) : (
          <p className="brief-empty">{emptyText}</p>
        )}
      </div>
      <footer className="brief-actions">
        {actions}
        {items.length > 3 && !expanded && <small>另有 {items.length - 3} 条</small>}
      </footer>
    </section>
  );
}
