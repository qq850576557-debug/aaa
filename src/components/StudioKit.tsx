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
  const unknown = value
    .filter((id) => !users.some((u) => u.id === id))
    .map((id) => ({ id, name: '已停用账号', active: false }));
  const ordered = all
    ? [...users, ...unknown]
    : [
        ...value.map(
          (id) => users.find((u) => u.id === id) || { id, name: '已停用账号', active: false },
        ),
        ...users.filter((u) => !value.includes(u.id)),
      ];
  const move = (id: string, delta: number) => {
    const i = value.indexOf(id),
      j = i + delta;
    if (i < 0 || j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="sd-people" role="group" aria-label={all ? '关联员工' : '参与人员及顺序'}>
      {users.length > 6 && (
        <input
          className="sd-input"
          aria-label="搜索员工"
          placeholder="搜索员工"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="sd-person-options">
        {all && (
          <button
            type="button"
            className="sd-person-choice sd-all"
            aria-pressed={!value.length}
            onClick={() => onChange([])}
          >
            全体员工
          </button>
        )}
        {ordered
          .filter((u) => u.name.includes(query))
          .map((u) => {
            const selected = value.includes(u.id),
              index = value.indexOf(u.id);
            return (
              <div className={'sd-person-choice' + (selected ? ' is-selected' : '')} key={u.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={u.active === false && !selected}
                    onChange={(e) =>
                      onChange(
                        e.target.checked ? [...value, u.id] : value.filter((id) => id !== u.id),
                      )
                    }
                  />
                  <span>
                    {!all && selected ? `${index + 1}. ` : ''}
                    {u.name}
                  </span>
                  {u.active === false && <small>停用</small>}
                </label>
                {!all && selected && (
                  <span className="sd-order-actions">
                    <button
                      type="button"
                      aria-label={`将${u.name}提前一位`}
                      disabled={index === 0}
                      onClick={() => move(u.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`将${u.name}延后一位`}
                      disabled={index === value.length - 1}
                      onClick={() => move(u.id, 1)}
                    >
                      ↓
                    </button>
                  </span>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
