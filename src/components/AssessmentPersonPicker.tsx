import { useEffect, useId, useRef, useState } from 'react';
import type { Person } from '../lib/model';
export function AssessmentPersonPicker({
  people,
  assigned,
  excluded,
  disabled,
  onSelect,
  label,
  value = '',
  selectedName = '',
}: {
  people: Person[];
  assigned: Set<string>;
  excluded: Set<string>;
  disabled?: boolean;
  onSelect: (id: string) => void;
  label: string;
  value?: string;
  selectedName?: string;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const options = people
    .filter(
      (p) =>
        !excluded.has(p.id) &&
        p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
    )
    .sort(
      (a, b) =>
        Number(assigned.has(b.id)) - Number(assigned.has(a.id)) ||
        a.name.localeCompare(b.name, 'zh-CN'),
    );
  return (
    <div
      className="assessment-person-picker"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={`assessment-choose-person ${value ? 'has-person' : ''}`}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selectedName || people.find((p) => p.id === value)?.name || '选择师傅'}{' '}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="assessment-person-menu">
          <input
            ref={search}
            type="search"
            aria-label="搜索师傅姓名"
            placeholder="搜索姓名"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div role="listbox" id={id} aria-label="已有师傅档案">
            <button
              type="button"
              role="option"
              aria-selected={!value}
              data-person-id=""
              onClick={() => {
                onSelect('');
                setOpen(false);
                setQuery('');
              }}
            >
              暂时不选
            </button>
            {options.map((p) => (
              <button
                type="button"
                role="option"
                data-person-id={p.id}
                aria-selected={p.id === value}
                key={p.id}
                title={[p.name, p.trade, p.notes].filter(Boolean).join(' · ')}
                onClick={() => {
                  onSelect(p.id);
                  setOpen(false);
                  setQuery('');
                }}
              >
                {p.name}
                <small>
                  {assigned.has(p.id) ? '已分配' : p.trade || '其他师傅'}
                  {people.filter((other) => other.name === p.name).length > 1
                    ? ' · ' + (p.notes.trim().slice(0, 12) || p.trade || '同名档案')
                    : ''}
                </small>
              </button>
            ))}
            {!options.length && <p>没有可选师傅</p>}
          </div>
        </div>
      )}
    </div>
  );
}
