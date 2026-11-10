export type CompactStat = {
  label: string;
  name: string;
  value: number;
  attention?: boolean;
  onClick: () => void;
};

/** The same live metrics, presented beside page titles without a second card row. */
export function CompactStats({
  items,
  layout = 'inline',
  scope = '工作空间统计',
}: {
  items: CompactStat[];
  layout?: 'inline' | 'cards';
  scope?: string;
}) {
  return (
    <div
      className={layout === 'cards' ? 'overview-stats ui-module-group' : 'compact-stats'}
      role="group"
      aria-label={scope}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`${layout === 'cards' ? 'overview-stat' : 'compact-stat'}${item.attention ? ' attention' : ''}`}
          aria-label={`${item.label}：${item.value}`}
          onClick={item.onClick}
        >
          <span>{layout === 'cards' ? item.label : item.name}</span>
          <strong>{item.value}</strong>
        </button>
      ))}
    </div>
  );
}
