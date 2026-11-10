export type CompactStat = {
  label: string;
  name: string;
  value: number;
  attention?: boolean;
  onClick: () => void;
};

/** The same live metrics, presented beside page titles without a second card row. */
export function CompactStats({ items }: { items: CompactStat[] }) {
  return (
    <div className="compact-stats" role="group" aria-label="工作空间统计">
      {items.map((item) => (
        <button
          key={item.label}
          className={`compact-stat${item.attention ? ' attention' : ''}`}
          aria-label={`${item.label}：${item.value}`}
          onClick={item.onClick}
        >
          <span>{item.name}</span>
          <strong>{item.value}</strong>
        </button>
      ))}
    </div>
  );
}
