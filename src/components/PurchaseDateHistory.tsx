import type { Purchase } from '../lib/model';
export function PurchaseDateHistory({ purchase }: { purchase: Purchase }) {
  const entries = purchase.deadlineHistory ?? [];
  if (!entries.length) return null;
  return (
    <span className="purchase-date-history">
      <button type="button" aria-label="查看采购日期变更记录">
        ⓘ
      </button>
      <span className="purchase-date-tooltip" role="tooltip">
        {entries.map((h, i) => (
          <span key={i}>
            {new Intl.DateTimeFormat('zh-CN', {
              timeZone: 'Asia/Shanghai',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            })
              .format(new Date(h.at))
              .replaceAll('/', '.')}{' '}
            {h.to > (h.actualFrom ?? h.from) ? '延期' : '提前'}至{h.to.replaceAll('-', '.')}
          </span>
        ))}
      </span>
    </span>
  );
}
