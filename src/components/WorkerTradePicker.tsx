import { useState } from 'react';
import { Search, Plus } from 'lucide-react';
import type { Data } from '../lib/model';
import { workerTradeChoices } from '../lib/worker-trades';

export function WorkerTradePicker({
  data,
  value,
  onChange,
  onManage,
}: {
  data: Data;
  value: string[];
  onChange: (ids: string[]) => void;
  onManage: () => void;
}) {
  const [search, setSearch] = useState('');
  const choices = workerTradeChoices(data).filter(
    (x) => !x.deleted || x.ids.some((key) => value.includes(key)),
  );
  const knownIds = new Set(choices.flatMap((x) => x.ids));
  const legacy = value.filter((key) => !knownIds.has(key));
  return (
    <fieldset className="worker-trade-picker span2">
      <legend>所属工种多选</legend>
      <div className="worker-picker-tools">
        <label className="worker-picker-search">
          <Search size={15} />
          <input
            aria-label="搜索人员工种"
            placeholder="搜索工种"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button type="button" onClick={onManage}>
          <Plus size={14} />
          工种管理
        </button>
        <button type="button" disabled={!value.length} onClick={() => onChange([])}>
          清除已选
        </button>
      </div>
      {legacy.length > 0 && (
        <small>已保留 {legacy.length} 条历史关联；勾选下方工种不会清除历史资料。</small>
      )}
      <div className="worker-trade-options" aria-label="人员工种选项">
        {choices
          .filter(
            (x) =>
              (x.active || x.ids.some((key) => value.includes(key))) &&
              x.label.toLowerCase().includes(search.trim().toLowerCase()),
          )
          .map((x) => {
            const checked = x.ids.some((key) => value.includes(key));
            return (
              <label key={x.id} className={`check ${checked ? 'chosen' : ''}`}>
                <input
                  type="checkbox"
                  aria-label={`人员工种${x.label}`}
                  checked={checked}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...new Set([...value, x.id])]
                        : value.filter((key) => !x.ids.includes(key)),
                    )
                  }
                />
                <span>
                  {x.label}
                  {!x.active ? '（停用）' : ''}
                </span>
              </label>
            );
          })}
      </div>
      {!choices.some((x) => x.active && x.label.includes(search.trim())) && (
        <small>没有匹配的工种，可在工种管理中新增。</small>
      )}
    </fieldset>
  );
}
