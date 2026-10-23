import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonths, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { dateOK, days, plus, today, weekday } from '../lib/model';
export function DateField({
  label,
  value,
  onChange,
  required = false,
  rangeStart,
  rangeEnd,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
  required?: boolean;
  rangeStart?: string;
  rangeEnd?: string;
}) {
  const uid = useId(),
    popover = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null);
  const [month, setMonth] = useState(() => startOfMonth(parseISO(dateOK(value) ? value : today())));
  function position() {
    const el = popover.current;
    if (!el?.matches(':popover-open') || !button.current) return;
    const rect = button.current.getBoundingClientRect(),
      bounds = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(rect.bottom + bounds.height + 8 > window.innerHeight ? rect.top - bounds.height - 8 : rect.bottom + 8, window.innerHeight - bounds.height - 8))}px`;
  }
  useEffect(() => {
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, []);
  function open() {
    setMonth(startOfMonth(parseISO(dateOK(value) ? value : today())));
    popover.current!.showPopover();
    position();
  }
  const first = format(startOfWeek(month, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  const grid = days(first, plus(first, 41));
  return (
    <div className="form-field">
      <label htmlFor={uid}>{label}</label>
      <div className="date-field">
        <input
          id={uid}
          type="text"
          inputMode="numeric"
          placeholder="YYYY-MM-DD"
          required={required}
          pattern="\d{4}-\d{2}-\d{2}"
          maxLength={10}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" ref={button} aria-label={`选择${label}`} onClick={open}>
          <CalendarDays size={18} />
        </button>
      </div>
      <div
        ref={popover}
        popover="auto"
        role="dialog"
        aria-label={`${label}日历`}
        className="calendar-popover"
      >
        <header>
          <button type="button" aria-label="上个月" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={17} />
          </button>
          <label className="sr-only" htmlFor={`${uid}-month`}>
            跳转月份
          </label>
          <input
            id={`${uid}-month`}
            type="month"
            min="1900-01"
            max="2200-12"
            value={format(month, 'yyyy-MM')}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(parseISO(e.target.value + '-01'));
            }}
          />
          <button type="button" aria-label="下个月" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={17} />
          </button>
        </header>
        <div className="calendar-grid">
          {'一二三四五六日'.split('').map((s) => (
            <span key={s}>周{s}</span>
          ))}
          {grid.map((d) => (
            <button
              key={d}
              type="button"
              aria-label={`选择 ${d}`}
              aria-pressed={d === value}
              disabled={!dateOK(d)}
              className={`${d.slice(0, 7) !== format(month, 'yyyy-MM') ? 'outside' : ''} ${d === value ? 'selected' : ''} ${rangeStart && rangeEnd && d >= rangeStart && d <= rangeEnd ? 'in-range' : ''}`}
              onClick={() => {
                onChange(d);
                popover.current?.hidePopover();
                button.current?.focus({ preventScroll: true });
              }}
            >
              {Number(d.slice(8))}
              <span className="sr-only">周{weekday(d)}</span>
            </button>
          ))}
        </div>
        <footer>
          <button
            type="button"
            onClick={() => {
              onChange(today());
              popover.current?.hidePopover();
            }}
          >
            今天
          </button>
          {!required && (
            <button
              type="button"
              onClick={() => {
                onChange('');
                popover.current?.hidePopover();
              }}
            >
              清除日期
            </button>
          )}
          <button type="button" onClick={() => popover.current?.hidePopover()}>
            关闭日历
          </button>
        </footer>
      </div>
    </div>
  );
}
