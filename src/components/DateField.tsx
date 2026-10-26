import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonths, addYears, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { dateOK, days, plus, today, weekday } from '../lib/model';
import './date-field.css';
export function DateField({
  label,
  value,
  onChange,
  required = false,
  rangeStart,
  rangeEnd,
  min = '1900-01-01',
  max = '2200-12-31',
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
  required?: boolean;
  rangeStart?: string;
  rangeEnd?: string;
  min?: string;
  max?: string;
  compact?: boolean;
}) {
  const uid = useId(),
    popover = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null);
  const lower = dateOK(min) ? min : '1900-01-01',
    upper = dateOK(max) ? max : '2200-12-31';
  const available = (d: string) => dateOK(d) && d >= lower && d <= upper;
  const clamp = (d: string) => (d < lower ? lower : d > upper ? upper : d);
  const initial = clamp(dateOK(value) ? value : today());
  const [month, setMonth] = useState(() => startOfMonth(parseISO(initial))),
    [focused, setFocused] = useState(initial),
    [opened, setOpened] = useState(false);
  const focusRequested = useRef(false);
  function position() {
    const el = popover.current,
      anchor = button.current;
    if (!el?.matches(':popover-open') || !anchor) return;
    const viewport = window.visualViewport,
      r = anchor.getBoundingClientRect(),
      b = el.getBoundingClientRect();
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0,
      w = viewport?.width ?? innerWidth,
      h = viewport?.height ?? innerHeight;
    el.style.left = `${Math.max(left + 8, Math.min(r.left, left + w - b.width - 8))}px`;
    el.style.top = `${Math.max(top + 8, Math.min(r.bottom + b.height + 8 > top + h ? r.top - b.height - 8 : r.bottom + 8, top + h - b.height - 8))}px`;
  }
  useEffect(() => {
    input.current?.setCustomValidity(
      value && !available(value) ? '请输入可选范围内的有效日期（YYYY-MM-DD）' : '',
    );
  }, [value, lower, upper]);
  useLayoutEffect(() => {
    if (!opened) return;
    position();
    if (focusRequested.current) {
      popover.current
        ?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)
        ?.focus({ preventScroll: true });
      focusRequested.current = false;
    }
  }, [opened, month, focused]);
  useEffect(() => {
    if (!opened) return;
    const observer = new ResizeObserver(position);
    if (popover.current) observer.observe(popover.current);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [opened]);
  function close(restoreFocus = true) {
    popover.current?.hidePopover();
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  }
  function open() {
    if (opened) {
      close();
      return;
    }
    const d = clamp(dateOK(value) ? value : today());
    setMonth(startOfMonth(parseISO(d)));
    setFocused(d);
    focusRequested.current = true;
    popover.current?.showPopover();
    setOpened(true);
  }
  function choose(d: string) {
    if (d && !available(d)) return;
    onChange(d);
    close();
  }
  function moveMonth(next: Date) {
    const d = format(next, 'yyyy-MM-dd');
    if (!dateOK(d)) return;
    const target = clamp(d);
    setMonth(startOfMonth(parseISO(target)));
    setFocused(target);
  }
  function keyboard(e: KeyboardEvent<HTMLButtonElement>, d: string) {
    let next: string | undefined;
    if (e.key === 'ArrowLeft') next = plus(d, -1);
    if (e.key === 'ArrowRight') next = plus(d, 1);
    if (e.key === 'ArrowUp') next = plus(d, -7);
    if (e.key === 'ArrowDown') next = plus(d, 7);
    if (e.key === 'Home')
      next = format(startOfWeek(parseISO(d), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    if (e.key === 'End')
      next = plus(format(startOfWeek(parseISO(d), { weekStartsOn: 1 }), 'yyyy-MM-dd'), 6);
    if (e.key === 'PageUp' || e.key === 'PageDown')
      next = format(
        (e.shiftKey ? addYears : addMonths)(parseISO(d), e.key === 'PageUp' ? -1 : 1),
        'yyyy-MM-dd',
      );
    if (next) {
      e.preventDefault();
      next = clamp(next);
      setFocused(next);
      setMonth(startOfMonth(parseISO(next)));
      focusRequested.current = true;
    }
  }
  const first = format(startOfWeek(month, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
    grid = days(first, plus(first, 41));
  const period = format(month, 'yyyy-MM'),
    firstYear = Number(lower.slice(0, 4)),
    lastYear = Number(upper.slice(0, 4));
  return (
    <div className={`form-field date-picker ${compact ? 'date-picker-compact' : ''}`}>
      <label htmlFor={uid}>{label}</label>
      <div className="date-field">
        <input
          ref={input}
          id={uid}
          type="text"
          inputMode="numeric"
          placeholder="YYYY-MM-DD"
          required={required}
          pattern="\d{4}-\d{2}-\d{2}"
          maxLength={10}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4') {
              e.preventDefault();
              open();
            }
          }}
        />
        <button
          type="button"
          ref={button}
          aria-label={`选择${label}`}
          aria-haspopup="dialog"
          aria-expanded={opened}
          aria-controls={`${uid}-calendar`}
          onClick={open}
        >
          <CalendarDays size={17} />
        </button>
      </div>
      <div
        id={`${uid}-calendar`}
        ref={popover}
        popover="auto"
        role="dialog"
        aria-label={`${label}日历`}
        className="calendar-popover"
        onToggle={(e) => setOpened(e.currentTarget.matches(':popover-open'))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <header>
          <div className="calendar-period">
            <select
              aria-label="跳转年份"
              value={format(month, 'yyyy')}
              onChange={(e) => moveMonth(parseISO(`${e.target.value}-${format(month, 'MM')}-01`))}
            >
              {Array.from(
                { length: Math.max(0, lastYear - firstYear + 1) },
                (_, i) => firstYear + i,
              ).map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </select>
            <select
              aria-label="跳转月份"
              value={format(month, 'MM')}
              onChange={(e) => moveMonth(parseISO(`${format(month, 'yyyy')}-${e.target.value}-01`))}
            >
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                <option
                  key={m}
                  value={m}
                  disabled={
                    `${format(month, 'yyyy')}-${m}` < lower.slice(0, 7) ||
                    `${format(month, 'yyyy')}-${m}` > upper.slice(0, 7)
                  }
                >
                  {Number(m)}月
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            aria-label="上个月"
            disabled={period <= lower.slice(0, 7)}
            onClick={() => moveMonth(addMonths(month, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            aria-label="下个月"
            disabled={period >= upper.slice(0, 7)}
            onClick={() => moveMonth(addMonths(month, 1))}
          >
            <ChevronRight size={18} />
          </button>
        </header>
        <div
          className="calendar-grid"
          role="group"
          aria-label={`${format(month, 'yyyy年M月')}日期`}
        >
          {'一二三四五六日'.split('').map((s) => (
            <span key={s}>周{s}</span>
          ))}
          {grid.map((d) => (
            <button
              key={d}
              type="button"
              data-day={d}
              aria-label={`选择 ${d}`}
              aria-pressed={d === value}
              aria-current={d === today() ? 'date' : undefined}
              tabIndex={d === focused ? 0 : -1}
              disabled={!available(d)}
              className={`${d.slice(0, 7) !== period ? 'outside' : ''} ${d === value ? 'selected' : ''} ${d === today() ? 'calendar-today' : ''} ${rangeStart && rangeEnd && d >= rangeStart && d <= rangeEnd ? 'in-range' : ''}`}
              onFocus={() => setFocused(d)}
              onKeyDown={(e) => keyboard(e, d)}
              onClick={() => choose(d)}
            >
              {Number(d.slice(8))}
              <span className="sr-only">周{weekday(d)}</span>
            </button>
          ))}
        </div>
        <footer>
          <button type="button" disabled={!available(today())} onClick={() => choose(today())}>
            今天
          </button>
          {!required && (
            <button type="button" onClick={() => choose('')}>
              清除日期
            </button>
          )}
          <button type="button" onClick={() => close()}>
            关闭日历
          </button>
        </footer>
      </div>
    </div>
  );
}
