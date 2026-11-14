import { useState } from 'react';
export type StudioUser = { id: string; name: string; active?: boolean };
export function PeoplePicker({
  users,
  value,
  onChange,
  all = false,
}: {
  users: StudioUser[];
  value: string[];
  onChange: (ids: string[]) => void;
  all?: boolean;
}) {
  const [query, setQuery] = useState('');
  return (
    <div className="sd-people">
      <div className="sd-selected">
        {all && (
          <button
            type="button"
            className={'sd-chip ' + (!value.length ? 'selected' : '')}
            onClick={() => onChange([])}
          >
            全体员工
          </button>
        )}
        {value.map((id, i) => (
          <span className="sd-chip selected" key={id}>
            {!all && <span>{i + 1}. </span>}
            {users.find((u) => u.id === id)?.name || '已停用账号'}
            {!all && i > 0 && (
              <button
                type="button"
                aria-label={`将${users.find((u) => u.id === id)?.name || '这位员工'}提前一位`}
                onClick={() => {
                  const v = [...value];
                  [v[i - 1], v[i]] = [v[i], v[i - 1]];
                  onChange(v);
                }}
              >
                ↑
              </button>
            )}
            <button
              type="button"
              aria-label="移除关联人员"
              onClick={() => onChange(value.filter((x) => x !== id))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {users.length > 6 && (
        <input
          className="sd-input"
          aria-label="搜索员工"
          placeholder="搜索并选择员工"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="sd-options">
        {users
          .filter((u) => u.name.includes(query))
          .map((u) => (
            <label key={u.id}>
              <input
                type="checkbox"
                disabled={u.active === false && !value.includes(u.id)}
                checked={value.includes(u.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))
                }
              />
              <span>{u.name}</span>
              {u.active === false && <small>停用</small>}
            </label>
          ))}
      </div>
    </div>
  );
}
