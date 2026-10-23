import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

/** Controlled candidate field; clearing the value never deletes the shared library. */
export function NameField({
  label,
  value,
  history,
  onChange,
  onForget,
}: {
  label: string;
  value: string;
  history: string[];
  onChange: (name: string) => void;
  onForget: (name: string) => void;
}) {
  const uid = useId(),
    root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const matches = history.filter((n) => !value || n.includes(value));
  return (
    <div className="form-field name-field" ref={root}>
      <label htmlFor={uid}>{label}</label>
      <div className="name-input">
        <input
          id={uid}
          value={value}
          maxLength={100}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${uid}-options`}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              root.current?.querySelector<HTMLButtonElement>('.name-option')?.focus();
            }
          }}
        />
        {value && (
          <button type="button" aria-label={`清空${label}`} onClick={() => onChange('')}>
            <X size={14} />
          </button>
        )}
        <button type="button" aria-label={`选择历史${label}`} onClick={() => setOpen(!open)}>
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div
          className="name-options"
          id={`${uid}-options`}
          role="listbox"
          aria-label={`${label}历史姓名`}
        >
          {matches.map((name) => (
            <div className="name-option-row" key={name}>
              <button
                type="button"
                className="name-option"
                role="option"
                aria-selected={value === name}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
              >
                {name}
              </button>
              <button
                type="button"
                className="forget-name"
                aria-label={`删除历史姓名${name}`}
                onClick={() => {
                  setOpen(false);
                  onForget(name);
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {!matches.length && <p>输入新姓名，保存时加入历史库</p>}
        </div>
      )}
    </div>
  );
}
