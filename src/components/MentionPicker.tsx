import { useEffect, useRef, useState } from 'react';
import { cloudApi, inCloud } from '../lib/cloud';
import './mentions.css';
type Account = { id: string; login: string; displayName: string; active?: boolean };
export function MentionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [accounts, setAccounts] = useState<Account[]>([]),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!inCloud() || (!open && !value.length)) return;
    let active = true;
    void cloudApi<{ accounts: Account[] }>(
      '/mention-accounts' +
        (value.length ? '?selected=' + encodeURIComponent(value.join(',')) : ''),
    )
      .then((r) => {
        if (active) {
          setAccounts(r.accounts);
          setError('');
        }
      })
      .catch(() => {
        if (active) setError('账号列表读取失败，请重新打开重试');
      });
    return () => {
      active = false;
    };
  }, [open]);
  if (!inCloud()) return null;
  const found = accounts.filter(
    (a) =>
      a.active !== false &&
      !value.includes(a.id) &&
      [a.login, a.displayName].some((s) =>
        s.toLocaleLowerCase().includes(query.replace(/^@/, '').trim().toLocaleLowerCase()),
      ),
  );
  const pick = (a: Account) => {
    if (disabled || value.includes(a.id)) return;
    onChange([...value, a.id]);
    setQuery('');
    input.current?.focus();
  };
  return (
    <div
      className="mention-picker form-field span2"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label>同时@负责人</label>
      <div className="mention-selected">
        {value.map((id) => (
          <button
            type="button"
            key={id}
            disabled={disabled}
            onClick={() => onChange(value.filter((x) => x !== id))}
            aria-label={`取消@${accounts.find((a) => a.id === id)?.displayName ?? id}`}
          >
            @{accounts.find((a) => a.id === id)?.displayName ?? '已关联账号'}{' '}
            <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <input
        ref={input}
        aria-label="@负责人搜索"
        placeholder="输入@姓名或账号，可连续选择多人"
        value={query}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === 'Enter' && open) {
            e.preventDefault();
            if (found[0]) pick(found[0]);
          }
        }}
      />
      {open && (
        <div className="mention-options" role="group" aria-label="可@员工">
          {error ? (
            <p role="alert">{error}</p>
          ) : found.length ? (
            found.map((a) => (
              <button type="button" key={a.id} disabled={disabled} onClick={() => pick(a)}>
                <strong>{a.displayName}</strong>
                <small>{a.login}</small>
              </button>
            ))
          ) : (
            <small>没有匹配的有效账号</small>
          )}
        </div>
      )}
    </div>
  );
}
