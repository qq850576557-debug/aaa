import type { Data } from '../lib/model';
export function StaffPicker({
  data,
  value,
  onChange,
}: {
  data: Data;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="staff-picker span2">
      <legend>选择已登记人员</legend>
      {(['施工人员', '项目经理', '设计人员', '监理'] as const).map((role) => {
        const selected = value.filter((id) =>
          data.people?.some((p) => p.id === id && p.role === role),
        );
        return (
          <label key={role}>
            {role}
            <select
              aria-label={`选择${role}`}
              value={selected[0] ?? ''}
              onChange={(e) =>
                onChange([
                  ...value.filter((id) => !selected.includes(id)),
                  ...(e.target.value ? [e.target.value] : []),
                ])
              }
            >
              <option value="">未分配</option>
              {data.people
                ?.filter(
                  (p) => p.role === role && ((p.active && !p.deleted) || value.includes(p.id)),
                )
                .map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.active || p.deleted}>
                    {p.name}
                    {!p.active || p.deleted ? '（已停用）' : ''}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
      <div className="span2 worker-multiple">
        <span>施工人员多选</span>
        {data.people
          ?.filter(
            (p) => p.role === '施工人员' && ((p.active && !p.deleted) || value.includes(p.id)),
          )
          .map((p) => (
            <label key={p.id} className="check">
              <input
                type="checkbox"
                aria-label={`分配施工人员${p.name}`}
                checked={value.includes(p.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))
                }
              />
              {p.name}
            </label>
          ))}
      </div>
      <small>档案新增与资料维护请到左侧「人员管理」。已有文字登记保留在原记录中。</small>
    </fieldset>
  );
}
