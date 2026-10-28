import { expect, it } from 'vitest';
import {
  inventory,
  materialPeriod,
  materialAnalysis,
  convertQuantity,
  milli,
  cents,
  stockKey,
  type MaterialEvent,
  type MaterialState,
  type Material,
  type MaterialContext,
  type MaterialProject,
} from './materials';
import { emptyData, newProject } from './model';
let seq = 0;
function event(
  kind: MaterialEvent['kind'],
  quantity: string,
  patch: Partial<MaterialEvent> = {},
): MaterialEvent {
  seq++;
  return {
    id: 'e' + seq,
    seq,
    requestId: 'request' + seq,
    kind,
    quantity,
    baseQty: quantity,
    unitPrice: '10',
    inputUnit: 'm²',
    unit: 'm²',
    conversionFactor: '1',
    projectId: 'a',
    projectName: '工地A',
    materialId: 'tile',
    materialName: '砖',
    contextId: 'ctx',
    targetProjectId: '',
    purchaseId: '',
    date: '2026-10-01',
    referenceId: '',
    reason: '测试原始单据',
    actorId: 'owner',
    actorName: '负责人',
    at: '2026-10-01T00:00:00Z',
    ...patch,
  };
}
it('orders are not stock/use; issue/return are custody moves and transfer preserves combined assets/cost', () => {
  seq = 0;
  const events = [
    event('order', '500'),
    event('opening', '100'),
    event('receipt', '20'),
    event('issue', '60'),
    event('use', '40'),
    event('loss_crew', '5'),
    event('return', '15'),
    event('supplier_return', '5'),
    event('transfer', '10', { targetProjectId: 'b' }),
  ];
  const r = inventory(events),
    a = r.stocks.get(stockKey('a', 'tile'))!,
    b = r.stocks.get(stockKey('b', 'tile'))!;
  expect(a.ordered).toBe(500000n);
  expect(a.site.qty).toBe(60000n);
  expect(b.site.qty).toBe(10000n);
  expect(a.used).toBe(40000n);
  expect(a.loss).toBe(5000n);
  expect(a.crews.get('ctx')!.qty).toBe(0n);
  expect(
    a.site.value + b.site.value + a.usedValue + a.lossValue + r.trace.get(events[7].id)!.cost,
  ).toBe(1200000000n);
  const period = materialPeriod(events, '2026-10-01', '2026-10-31');
  expect(period.every((r) => r.check)).toBe(true);
  expect(period.find((r) => r.projectId === 'a')?.endPhysical).toBeNull();
});
it('weighted cost uses integer micro-yuan and large quantities stay exact', () => {
  seq = 0;
  const e = [
    event('opening', '10', { unitPrice: '2' }),
    event('receipt', '10', { unitPrice: '4' }),
    event('issue', '10'),
    event('use', '10'),
  ];
  const r = inventory(e),
    s = r.stocks.get(stockKey('a', 'tile'))!;
  expect(s.usedValue).toBe(30000000n);
  expect(s.site.value).toBe(30000000n);
  const large = inventory([
    event('opening', '999999999.999', { unitPrice: '99999999.99' }),
  ]).stocks.get(stockKey('a', 'tile'))!;
  expect(large.site.value).toBe(milli('999999999.999') * cents('99999999.99') * 10n);
});
it('count discrepancies do not silently become loss; reconciliation is limited and close requires zero stock', () => {
  seq = 0;
  const opening = event('opening', '100'),
    count = event('count_site', '90', { contextId: '' });
  const records = [opening, count];
  let r = inventory(records);
  expect(r.stocks.get(stockKey('a', 'tile'))!.site.qty).toBe(100000n);
  expect(r.stocks.get(stockKey('a', 'tile'))!.loss).toBe(0n);
  records.push(event('loss_site', '6', { referenceId: count.id }));
  records.push(event('adjust_out', '4', { contextId: '', referenceId: count.id }));
  r = inventory(records);
  expect(r.stocks.get(stockKey('a', 'tile'))!.counts.get('site')!.difference).toBe(0n);
  expect(r.stocks.get(stockKey('a', 'tile'))!.loss).toBe(6000n);
  expect(materialPeriod(records, '2026-10-01', '2026-10-01').every((r) => r.check)).toBe(true);
  expect(() => inventory([...records, event('close', '0')])).toThrow(/余料/);
  expect(() =>
    inventory([...records, event('adjust_out', '1', { referenceId: count.id, contextId: '' })]),
  ).toThrow(/盘点/);
  records.push(event('transfer', '90', { targetProjectId: 'b' }), event('close', '0'));
  expect(inventory(records).stocks.get(stockKey('a', 'tile'))!.closed).toBe(true);
  expect(() => inventory([...records, event('receipt', '1')])).toThrow(/关闭/);
  records.push(event('reopen', '0'), event('receipt', '1'));
  expect(inventory(records).stocks.get(stockKey('a', 'tile'))!.site.qty).toBe(1000n);
});
it('negative stock and unknown conversion are rejected; explicit conversion preserves unit/spec identity', () => {
  seq = 0;
  expect(() => inventory([event('issue', '1')])).toThrow(/库存不足/);
  const m = {
    id: 'tile',
    version: 1,
    name: '砖',
    category: '瓷砖',
    unit: 'm²',
    specification: '600x600',
    performance: '防滑A',
    active: true,
    conversions: [{ unit: '箱', factor: '1.44' }],
  } as Material;
  expect(convertQuantity(m, '2', '箱')).toEqual({ quantity: '2.880', factor: '1.44' });
  expect(() => convertQuantity(m, '1', 'kg')).toThrow(/换算/);
  expect(() => convertQuantity(m, '0.001', '箱')).toThrow(/精确/);
  const r = inventory([
    event('opening', '1'),
    event('opening', '2', { materialId: 'different-spec' }),
  ]);
  expect(r.stocks.size).toBe(2);
});
it('owner correction reverses actual counters and value without deleting records', () => {
  seq = 0;
  const opening = event('opening', '10'),
    issue = event('issue', '5');
  const all = [opening, issue, event('reverse', '0', { referenceId: issue.id })];
  const r = inventory(all).stocks.get(stockKey('a', 'tile'))!;
  expect(r.site.qty).toBe(10000n);
  expect(r.site.value).toBe(100000000n);
  expect(r.issued).toBe(0n);
  expect(all).toHaveLength(3);
  expect(() => inventory([...all, event('reverse', '0', { referenceId: issue.id })])).toThrow(
    /冲销/,
  );
});
it('interval opening/closing quantities reconcile, supplier return and inter-project flow never become use', () => {
  seq = 0;
  const all = [
    event('opening', '10', { date: '2026-09-30' }),
    event('receipt', '4'),
    event('transfer', '3', { targetProjectId: 'b' }),
    event('supplier_return', '1'),
  ];
  const report = materialPeriod(all, '2026-10-01', '2026-10-31');
  const a = report.find((r) => r.projectId === 'a')!;
  expect(a.begin).toBe('10.000');
  expect(a.endBook).toBe('10.000');
  expect(a.used).toBe('0.000');
  expect(a.transferOut).toBe('3.000');
  expect(a.supplierReturn).toBe('1.000');
  expect(report.every((r) => r.check)).toBe(true);
});
function comparison() {
  seq = 0;
  const data = emptyData(),
    state: MaterialState = { materials: [], projects: [], contexts: [], events: [], alerts: [] };
  for (let i = 0; i < 6; i++) {
    const id = 'p' + i;
    data.projects.push({ ...newProject(), id, name: id, status: '已完工' });
    state.projects.push({
      projectId: id,
      projectName: id,
      version: 1,
      buildingArea: '100',
      constructionArea: '10',
      regions: [],
      projectType: '住宅',
      layout: '三房',
      grade: '中档',
      design: '直铺',
    } as MaterialProject);
    const c = {
      id: 'c' + i,
      version: 1,
      projectId: id,
      projectName: id,
      materialId: 'tile',
      phase: '贴砖',
      zone: '客厅',
      tradeId: '',
      taskId: '',
      teamName: '班组',
      staffIds: [],
      basisKind: 'area',
      basis: '10',
      coats: 1,
      process: '薄贴',
      paving: '直铺',
      budgetQty: '1000',
      budgetPrice: '10',
      progress: 100,
      finalized: true,
    } as MaterialContext;
    state.contexts.push(c);
    const q = i === 0 ? '100' : String((i + 1) * 10);
    state.events.push(
      event('opening', q, { projectId: id, contextId: c.id }),
      event('issue', q, { projectId: id, contextId: c.id }),
      event('use', q, { projectId: id, contextId: c.id }),
    );
  }
  return { data, state };
}
it('five distinct comparable projects produce explainable quantiles; insufficient/incomparable samples never fabricate probability', () => {
  const { data, state } = comparison();
  let a = materialAnalysis(state, data),
    r = a.rows[0];
  expect(r.samples).toBe(5);
  expect(r.mean).toBe(4);
  expect(r.median).toBe(4);
  expect(r.upper).toBe(8);
  expect(r.estimatedExcess).toBe(20);
  expect(r.probability).toBeNull();
  expect(a.risks.some((x) => x.contextId === 'c0')).toBe(true);
  state.contexts[1].basisKind = 'length';
  a = materialAnalysis(state, data);
  r = a.rows[0];
  expect(r.samples).toBe(4);
  expect(r.median).toBeNull();
  expect(r.upper).toBeNull();
  expect(r.estimatedExcess).toBeNull();
  expect(r.reason).toContain('不足5');
  expect(r.probability).toBeNull();
  state.projects = [];
  expect(materialAnalysis(state, data).rows[0].missing).toContain('项目比较条件');
});
it('physical stock rolls forward after a count; linked loss/adjustment reconciles books only and old reversals are blocked', () => {
  seq = 0;
  const a = event('opening', '100'),
    count = event('count_site', '90', { contextId: '' });
  const all = [
    a,
    count,
    event('loss_site', '5', { referenceId: count.id }),
    event('adjust_out', '5', { referenceId: count.id, contextId: '' }),
    event('receipt', '5'),
    event('issue', '10'),
  ];
  const s = inventory(all).stocks.get(stockKey('a', 'tile'))!;
  expect(s.counts.get('site')!.physical).toBe(85000n);
  expect(s.site.qty).toBe(85000n);
  expect(s.counts.get('site')!.difference).toBe(0n);
  const end = materialPeriod(all, '2026-10-01', '2026-10-01')[0];
  expect(end.endPhysical).toBeNull(); // crew ten has not been physically counted
  all.push(event('count_crew', '10'));
  expect(materialPeriod(all, '2026-10-01', '2026-10-01')[0].endPhysical).toBe('95.000');
  expect(() => inventory([...all, event('reverse', '0', { referenceId: a.id })])).toThrow(/实盘/);
});
it('a material difference cannot be hidden as usage or removed by over-reconciling a count', () => {
  seq = 0;
  const opening = event('opening', '10'),
    count = event('count_site', '12', { contextId: '' });
  const a = [opening, count];
  expect(() =>
    inventory([...a, event('adjust_out', '2', { referenceId: count.id, contextId: '' })]),
  ).toThrow(/方向/);
  const s = inventory([
    ...a,
    event('adjust_in', '2', { referenceId: count.id, contextId: '' }),
  ]).stocks.get(stockKey('a', 'tile'))!;
  expect(s.site.qty).toBe(12000n);
  expect(s.used).toBe(0n);
  expect(s.loss).toBe(0n);
  expect(s.counts.get('site')!.physical).toBe(12000n);
});
it('comparison does not count several zones of one project as independent projects or compare different methods', () => {
  const { state, data } = comparison();
  const copy = { ...state.contexts[1], id: 'zone-extra', zone: '厨房' };
  state.contexts.push(copy);
  state.events.push(event('opening', '20', { projectId: 'p1', materialId: 'second-spec' }));
  let row = materialAnalysis(state, data).rows[0];
  expect(row.samples).toBe(5);
  expect(row.mean).toBe(4);
  expect(row.medianUnitCost).toBe(40);
  expect(row.unitCostDifference).toBe(60);
  expect(row.relativeCost).toBe(1.5);
  state.contexts[1].process = '厚贴';
  row = materialAnalysis(state, data).rows[0];
  expect(row.samples).toBe(4);
  expect(row.upper).toBeNull();
  state.projects[0].constructionArea = '0';
  row = materialAnalysis(state, data).rows[0];
  expect(row.estimatedCost).toBeNull();
  expect(row.estimatedExcess).toBeNull();
  expect(row.missing).toContain('实际施工面积待核实');
});
it('count-linked loss reversal restores unresolved differences without inventing physical inventory', () => {
  seq = 0;
  const all = [event('opening', '20'), event('count_site', '15', { contextId: '' })];
  const loss = event('loss_site', '5', { referenceId: all[1].id });
  all.push(loss);
  let s = inventory(all).stocks.get(stockKey('a', 'tile'))!;
  expect(s.counts.get('site')!.difference).toBe(0n);
  all.push(event('reverse', '0', { referenceId: loss.id }));
  s = inventory(all).stocks.get(stockKey('a', 'tile'))!;
  expect(s.loss).toBe(0n);
  expect(s.site.qty).toBe(20000n);
  expect(s.counts.get('site')!.physical).toBe(15000n);
  expect(s.counts.get('site')!.difference).toBe(5000n);
  expect(() => inventory([...all, event('close', '1')])).toThrow(/必须为0/);
});

it('restored project completion/links are revalidated before using a historical material sample', () => {
  const { state, data } = comparison();
  expect(materialAnalysis(state, data).rows[0].samples).toBe(5);
  data.projects[1].status = '施工中';
  expect(materialAnalysis(state, data).rows[0].samples).toBe(4);
  state.contexts[2].taskId = 'missing-after-restore';
  expect(materialAnalysis(state, data).rows[0].samples).toBe(3);
  expect(materialAnalysis(state, data).rows.find((r) => r.id === 'c2')!.missing).toContain(
    '施工关联待复核',
  );
});
