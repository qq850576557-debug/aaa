import { useEffect, useRef, useState } from 'react';
import { cloudApi, inCloud } from '../lib/cloud';
import './mentions.css';
type Account = { id: string; login: string; displayName: string; active?: boolean };
export function MentionPicker({
  value,
  onChange,
  disabled = false,
  owner,
  onOwnerChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  owner?: string;
  onOwnerChange?: (text: string) => void;
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
  }, [open, value.join(',')]);
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
    if (onOwnerChange && query && owner?.endsWith(query))
      onOwnerChange(owner.slice(0, -query.length));
    setQuery('');
    input.current?.focus();
  };
  return (
    <div
      className={`mention-picker form-field span2 ${onOwnerChange ? 'owner-picker' : ''}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label htmlFor={onOwnerChange ? 'record-owner' : undefined}>
        {onOwnerChange ? '负责人' : '同时@负责人'}
      </label>
      <div className="mention-control">
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
          id={onOwnerChange ? 'record-owner' : undefined}
          aria-label={onOwnerChange ? '事项负责人' : '@负责人搜索'}
          placeholder={
            onOwnerChange ? '输入负责人姓名，或@搜索系统账号' : '输入@姓名或账号，可连续选择多人'
          }
          maxLength={onOwnerChange ? 100 : undefined}
          value={onOwnerChange ? (owner ?? '') : query}
          disabled={disabled}
          onFocus={() => setOpen(!onOwnerChange || !!query)}
          onChange={(e) => {
            const text = e.target.value;
            if (onOwnerChange) {
              const at = text.lastIndexOf('@');
              onOwnerChange(text);
              setQuery(at < 0 ? '' : text.slice(at));
              setOpen(at >= 0);
            } else {
              setQuery(text);
              setOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
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
      </div>
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
