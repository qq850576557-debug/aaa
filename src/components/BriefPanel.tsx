import { useRef, useState, type ReactNode } from 'react';
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
  previewLimit?: number;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() => runtimeExpansion.get(testId || title) ?? true);
  return (
    <section
      className={`panel workbench-card brief-panel ${expanded ? 'brief-expanded' : ''} ${className}`}
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
      {expanded && (
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
