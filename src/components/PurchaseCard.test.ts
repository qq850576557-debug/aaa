import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PurchaseCard } from './PurchaseCard';
import {
  emptyData,
  purchaseComplete,
  purchaseSchema,
  purchaseStatuses,
  type Purchase,
} from '../lib/model';

const purchase: Purchase = {
  id: 'purchase',
  projectId: 'project',
  name: '灯带',
  due: '2026-11-10',
  taskId: '',
  leadDays: 0,
  status: '待采购',
  owner: '',
  notes: '',
};

function card(status: Purchase['status'], canReopen = true) {
  return renderToStaticMarkup(
    createElement(PurchaseCard, {
      purchase: { ...purchase, status },
      data: emptyData(),
      now: '2026-11-10',
      onEdit: () => {},
      onStatus: () => {},
      canReopen,
    }),
  );
}

describe('shared purchase status controls', () => {
  it.each(purchaseStatuses)('offers all four statuses when currently %s', (status) => {
    const markup = card(status);
    expect([...markup.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])).toEqual([
      '待采购',
      '已下单',
      '已到货',
      '已完成',
    ]);
    expect(markup).toContain(`data-purchase-status="${status}"`);
    expect(markup).toContain(`<option value="${status}" selected="">${status}</option>`);
    expect(purchaseSchema.parse({ ...purchase, status }).status).toBe(status);
  });

  it.each(['已到货', '已完成'] as const)(
    'retains existing reopening permissions for %s',
    (status) => {
      const markup = card(status, false);
      expect(markup).toContain('<option value="待采购" disabled="">待采购</option>');
      expect(markup).toContain('<option value="已下单" disabled="">已下单</option>');
      expect(markup).not.toContain('<option value="已到货" disabled="">');
      expect(purchaseComplete({ ...purchase, status })).toBe(true);
    },
  );

  it('describes arrived purchases without relabeling them completed', () => {
    const markup = card('已到货');
    expect(markup).toContain('采购已到货');
    expect(markup).not.toContain('采购已完成');
  });
});
