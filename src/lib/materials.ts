import { z } from 'zod';
import { dateOK, isHistorical, type Data } from './model';
const text = z.string().trim().min(1).max(100);
export const amount = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, '请输入最多三位小数的非负数量');
export const money = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, '单价最多两位小数');
export const materialSchema = z
  .object({
    name: text,
    category: text,
    unit: text,
    specification: text,
    performance: text,
    active: z.boolean(),
    conversions: z.array(z.object({ unit: text, factor: amount }).strict()).max(20),
  })
  .strict()
  .refine(
    (m) => new Set([m.unit, ...m.conversions.map((c) => c.unit)]).size === m.conversions.length + 1,
    '换算单位不能重复',
  );
export type Material = z.infer<typeof materialSchema> & { id: string; version: number };
export const projectMaterialSchema = z
  .object({
    buildingArea: amount,
    constructionArea: amount,
    regions: z.array(z.object({ name: text, area: amount }).strict()).max(100),
    projectType: text,
    layout: text,
    grade: text,
    design: text,
  })
  .strict();
export type MaterialProject = z.infer<typeof projectMaterialSchema> & {
  projectId: string;
  version: number;
  projectName: string;
};
export const contextSchema = z
  .object({
    projectId: text,
    materialId: text,
    phase: text,
    zone: text,
    tradeId: z.string().max(100),
    taskId: z.string().max(100),
    teamName: text,
    staffIds: z.array(text).max(100),
    basisKind: z.enum(['area', 'length', 'area_coats']),
    basis: amount,
    coats: z.number().int().min(1).max(20),
    process: text,
    paving: text,
    budgetQty: amount,
    budgetPrice: money,
    progress: z.number().min(0).max(100),
    finalized: z.boolean(),
  })
  .strict();
export type MaterialContext = z.infer<typeof contextSchema> & {
  id: string;
  version: number;
  projectName: string;
};
export const eventKinds = [
  'opening',
  'order',
  'receipt',
  'issue',
  'return',
  'use',
  'loss_site',
  'loss_crew',
  'supplier_return',
  'transfer',
  'count_site',
  'count_crew',
  'adjust_in',
  'adjust_out',
  'close',
  'reopen',
  'reverse',
] as const;
export type EventKind = (typeof eventKinds)[number];
export const eventLabels: Record<EventKind, string> = {
  opening: '期初库存',
  order: '采购订单',
  receipt: '采购入场',
  issue: '领用给班组',
  return: '班组余料退回',
  use: '确认实际使用',
  loss_site: '确认现场库存损耗',
  loss_crew: '确认班组损耗',
  supplier_return: '退货给供应商',
  transfer: '跨工地调拨',
  count_site: '现场库存盘点',
  count_crew: '班组库存盘点',
  adjust_in: '盘盈核实入账',
  adjust_out: '盘亏差异核实',
  close: '完工清仓关闭',
  reopen: '重开材料台账',
  reverse: '冲销原流水',
};
export const eventSchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum(eventKinds),
    projectId: text,
    materialId: text,
    contextId: z.string().max(100),
    targetProjectId: z.string().max(100),
    purchaseId: z.string().max(100),
    date: z.string().refine(dateOK),
    quantity: amount,
    inputUnit: text,
    unitPrice: money,
    referenceId: z.string().max(100),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type MaterialEvent = z.infer<typeof eventSchema> & {
  id: string;
  seq: number;
  actorId: string;
  actorName: string;
  at: string;
  projectName: string;
  materialName: string;
  unit: string;
  baseQty: string;
  conversionFactor: string;
  costMicros?: string;
};
export const alertStatuses = [
  '待核查',
  '核查中',
  '已确认正常',
  '已确认异常',
  '已处理',
  '已关闭',
] as const;
export type AlertStatus = (typeof alertStatuses)[number];
export type MaterialAlert = {
  id: string;
  key: string;
  version: number;
  projectId: string;
  materialId: string;
  contextId: string;
  status: AlertStatus;
  assigneeId: string;
  reason: string;
  fingerprint: string;
  detail: Risk;
  sourceResolved: boolean;
  updatedAt: string;
  updatedBy: string;
};
export type MaterialState = {
  materials: Material[];
  projects: MaterialProject[];
  contexts: MaterialContext[];
  events: MaterialEvent[];
  alerts: MaterialAlert[];
};
export const milli = (s: string) => {
  if (!amount.safeParse(s).success) throw Error('数量无效');
  const [a, b = ''] = s.split('.');
  return BigInt(a) * 1000n + BigInt(b.padEnd(3, '0'));
};
export const cents = (s: string) => {
  if (!money.safeParse(s).success) throw Error('金额无效');
  const [a, b = ''] = s.split('.');
  return BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
};
export function decimal(n: bigint, scale = 1000n) {
  const sign = n < 0n ? '-' : '';
  n = n < 0n ? -n : n;
  const places = scale.toString().length - 1;
  return sign + (n / scale).toString() + '.' + (n % scale).toString().padStart(places, '0');
}
export const yuan = (n: bigint) => decimal((n + (n >= 0 ? 5000n : -5000n)) / 10000n, 100n);
export function convertQuantity(m: Material, q: string, unit: string) {
  const f = unit === m.unit ? '1' : m.conversions.find((c) => c.unit === unit)?.factor;
  if (!f || milli(f) <= 0n) throw Error('缺少明确单位换算规则');
  const scaled = milli(q) * milli(f);
  if (scaled % 1000n) throw Error('换算结果无法精确到0.001，请调整数量或单位规则');
  return { quantity: decimal(scaled / 1000n), factor: f };
}
type Bucket = { qty: bigint; value: bigint };
export type Stock = {
  projectId: string;
  materialId: string;
  site: Bucket;
  crews: Map<string, Bucket>;
  opening: bigint;
  adjustment: bigint;
  siteDate: string;
  ordered: bigint;
  received: bigint;
  issued: bigint;
  returned: bigint;
  transferIn: bigint;
  transferOut: bigint;
  vendorReturn: bigint;
  used: bigint;
  loss: bigint;
  usedValue: bigint;
  lossValue: bigint;
  closed: boolean;
  lastDate: string;
  counts: Map<
    string,
    {
      id: string;
      difference: bigint;
      observed: bigint;
      physical: bigint;
      seq: number;
      date: string;
    }
  >;
};
export const stockKey = (projectId: string, materialId: string) =>
  JSON.stringify([projectId, materialId]);
export function inventory(events: MaterialEvent[]) {
  const stocks = new Map<string, Stock>(),
    trace = new Map<
      string,
      { event: MaterialEvent; cost: bigint; apply: (direction: bigint) => void }
    >(),
    contextUse = new Map<string, { used: bigint; loss: bigint; cost: bigint }>(),
    reversed = new Set<string>();
  const stock = (p: string, m: string) => {
    const k = stockKey(p, m);
    if (!stocks.has(k))
      stocks.set(k, {
        projectId: p,
        materialId: m,
        site: { qty: 0n, value: 0n },
        crews: new Map(),
        opening: 0n,
        adjustment: 0n,
        siteDate: '',
        ordered: 0n,
        received: 0n,
        issued: 0n,
        returned: 0n,
        transferIn: 0n,
        transferOut: 0n,
        vendorReturn: 0n,
        used: 0n,
        loss: 0n,
        usedValue: 0n,
        lossValue: 0n,
        closed: false,
        lastDate: '',
        counts: new Map(),
      });
    return stocks.get(k)!;
  };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const s = stock(e.projectId, e.materialId),
      q = milli(e.baseQty),
      crewKey = e.contextId;
    if (['close', 'reopen', 'reverse'].includes(e.kind) && q !== 0n)
      throw Error('清仓、重开或冲销操作的数量必须为0');
    const crew = (target = s) => {
      if (!crewKey) throw Error('此操作必须关联施工阶段/班组');
      if (!target.crews.has(crewKey)) target.crews.set(crewKey, { qty: 0n, value: 0n });
      return target.crews.get(crewKey)!;
    };
    const context = () => {
      if (!e.contextId) throw Error('实际使用和损耗须关联施工阶段/班组');
      if (!contextUse.has(e.contextId))
        contextUse.set(e.contextId, { used: 0n, loss: 0n, cost: 0n });
      return contextUse.get(e.contextId)!;
    };
    const take = (b: Bucket) => {
      if (q > b.qty) throw Error('库存不足，不能领用、消耗或调出');
      return q === b.qty ? b.value : (b.value * q) / b.qty;
    };
    let cost = 0n,
      apply: ((d: bigint) => void) | undefined;
    const physicalMove = (bucket: Bucket, delta: bigint) => {
      if (
        ['adjust_in', 'adjust_out'].includes(e.kind) ||
        (e.kind.startsWith('loss_') && e.referenceId)
      )
        return;
      for (const stock of stocks.values()) {
        const location =
          bucket === stock.site ? 'site' : [...stock.crews].find(([, b]) => b === bucket)?.[0];
        const count = location ? stock.counts.get(location) : undefined;
        if (count) count.physical += delta;
      }
    };
    const move = (from: Bucket | undefined, to: Bucket | undefined, d: bigint) => {
      if (from) {
        from.qty -= q * d;
        from.value -= cost * d;
        physicalMove(from, -q * d);
      }
      if (to) {
        to.qty += q * d;
        to.value += cost * d;
        physicalMove(to, q * d);
      }
    };
    if (e.kind === 'reverse') {
      const old = trace.get(e.referenceId);
      if (
        !old ||
        reversed.has(e.referenceId) ||
        ['reverse', 'count_site', 'count_crew', 'close', 'reopen'].includes(old.event.kind) ||
        old.event.projectId !== e.projectId ||
        old.event.materialId !== e.materialId
      )
        throw Error('原流水无法冲销');
      if (s.closed) throw Error('先重开材料台账再冲销');
      if (
        [s, stock(old.event.targetProjectId || old.event.projectId, e.materialId)].some((s) =>
          [...s.counts.values()].some((c) => c.seq > old.event.seq),
        )
      )
        throw Error('原流水后已有实盘，请按盘点差异核实更正');
      old.apply(-1n);
      reversed.add(e.referenceId);
      cost = -old.cost;
    } else if (e.kind === 'reopen') {
      if (!s.closed) throw Error('台账尚未关闭');
      s.closed = false;
    } else {
      if (s.closed) throw Error('材料台账已关闭，请负责人重开');
      if (e.kind === 'close') {
        if (
          s.site.qty ||
          [...s.crews.values()].some((b) => b.qty) ||
          [...s.counts.values()].some((c) => c.difference)
        )
          throw Error('仍有余料或未核实盘点差异，不能清仓关闭');
        s.closed = true;
      } else if (e.kind === 'count_site' || e.kind === 'count_crew') {
        const b = e.kind === 'count_site' ? s.site : crew();
        s.counts.set(e.kind === 'count_site' ? 'site' : crewKey, {
          id: e.id,
          difference: b.qty - q,
          observed: q,
          physical: q,
          seq: e.seq,
          date: e.date,
        });
      } else {
        if (q <= 0n) throw Error('流水数量必须大于零');
        if (e.kind === 'opening' || e.kind === 'receipt') {
          if (e.kind === 'opening' && (s.lastDate || s.site.qty))
            throw Error('期初库存必须是此材料首条库存流水');
          cost = q * cents(e.unitPrice) * 10n;
          apply = (d) => {
            move(undefined, s.site, d);
            if (e.kind === 'receipt') s.received += q * d;
            else s.opening += q * d;
          };
        }
        if (e.kind === 'order')
          apply = (d) => {
            s.ordered += q * d;
          };
        if (e.kind === 'issue') {
          const b = crew();
          cost = take(s.site);
          apply = (d) => {
            move(s.site, b, d);
            s.issued += q * d;
          };
        }
        if (e.kind === 'return') {
          const b = crew();
          cost = take(b);
          apply = (d) => {
            move(b, s.site, d);
            s.returned += q * d;
          };
        }
        if (e.kind === 'use' || e.kind === 'loss_crew' || e.kind === 'loss_site') {
          const b = e.kind === 'loss_site' ? s.site : crew(),
            c = context();
          cost = take(b);
          apply = (d) => {
            move(b, undefined, d);
            if (e.kind === 'use') {
              s.used += q * d;
              s.usedValue += cost * d;
              c.used += q * d;
            } else {
              s.loss += q * d;
              s.lossValue += cost * d;
              c.loss += q * d;
            }
            c.cost += cost * d;
          };
        }
        if (e.kind === 'supplier_return') {
          cost = take(s.site);
          apply = (d) => {
            move(s.site, undefined, d);
            s.vendorReturn += q * d;
          };
        }
        if (e.kind === 'transfer') {
          if (e.targetProjectId === e.projectId || !e.targetProjectId)
            throw Error('请选择不同的接收工地');
          const dest = stock(e.targetProjectId, e.materialId);
          if (dest.closed) throw Error('接收工地台账已关闭');
          cost = take(s.site);
          apply = (d) => {
            move(s.site, dest.site, d);
            s.transferOut += q * d;
            dest.transferIn += q * d;
          };
          dest.lastDate = e.date;
          dest.siteDate = e.date;
        }
        if (e.kind === 'adjust_in' || e.kind === 'adjust_out') {
          if (!e.referenceId) throw Error('库存调整必须关联盘点记录');
          const b = e.contextId ? crew() : s.site;
          cost = e.kind === 'adjust_out' ? take(b) : q * cents(e.unitPrice) * 10n;
          apply = (d) => {
            move(
              e.kind === 'adjust_out' ? b : undefined,
              e.kind === 'adjust_in' ? b : undefined,
              d,
            );
            s.adjustment += q * d * (e.kind === 'adjust_in' ? 1n : -1n);
          };
        }
        if (!apply) throw Error('不支持的流水类型');
        if (
          e.referenceId &&
          ['adjust_in', 'adjust_out', 'loss_site', 'loss_crew'].includes(e.kind)
        ) {
          const key = e.contextId && e.kind !== 'loss_site' ? crewKey : 'site',
            count = s.counts.get(key);
          const sign = e.kind === 'adjust_in' ? -1n : 1n;
          if (
            !count ||
            count.id !== e.referenceId ||
            count.difference * sign <= 0n ||
            q > (count.difference < 0n ? -count.difference : count.difference)
          )
            throw Error('盘点引用、差异方向或核销数量无效');
          const action = apply;
          apply = (d) => {
            action(d);
            count.difference -= q * sign * d;
          };
        }
        apply(1n);
        trace.set(e.id, { event: e, cost, apply });
      }
    }
    if (e.kind !== 'order') s.lastDate = e.date;
    if (
      [
        'opening',
        'receipt',
        'issue',
        'return',
        'loss_site',
        'supplier_return',
        'transfer',
        'adjust_in',
        'adjust_out',
        'reverse',
      ].includes(e.kind)
    )
      s.siteDate = e.date;
    for (const x of stocks.values())
      if ([...x.counts.values()].some((c) => c.physical < 0n))
        throw Error('操作超过已知盘点实存，请先核实库存差异');
    for (const x of stocks.values())
      for (const b of [x.site, ...x.crews.values()])
        if (b.qty < 0n || b.value < 0n) throw Error('冲销导致数量或价值为负，请先核对后续流水');
  }
  return { stocks, trace, contextUse, reversed };
}
export function stockDTO(s: Stock) {
  const crews = [...s.crews].map(([contextId, b]) => ({
    contextId,
    quantity: decimal(b.qty),
    value: yuan(b.value),
  }));
  const crewQty = [...s.crews.values()].reduce((a, b) => a + b.qty, 0n);
  return {
    projectId: s.projectId,
    materialId: s.materialId,
    siteQty: decimal(s.site.qty),
    crewQty: decimal(crewQty),
    totalQty: decimal(s.site.qty + crewQty),
    value: yuan(s.site.value + [...s.crews.values()].reduce((a, b) => a + b.value, 0n)),
    valueMicros: (
      s.site.value + [...s.crews.values()].reduce((a, b) => a + b.value, 0n)
    ).toString(),
    ordered: decimal(s.ordered),
    received: decimal(s.received),
    issued: decimal(s.issued),
    returned: decimal(s.returned),
    transferIn: decimal(s.transferIn),
    transferOut: decimal(s.transferOut),
    vendorReturn: decimal(s.vendorReturn),
    used: decimal(s.used),
    loss: decimal(s.loss),
    usedCost: yuan(s.usedValue),
    lossCost: yuan(s.lossValue),
    closed: s.closed,
    lastDate: s.lastDate,
    siteDate: s.siteDate,
    opening: decimal(s.opening),
    adjustment: decimal(s.adjustment),
    crews,
    counts: [...s.counts].map(([location, c]) => ({
      location,
      ...c,
      difference: decimal(c.difference),
      observed: decimal(c.observed),
      physical: decimal(c.physical),
    })),
  };
}
export type Risk = {
  key: string;
  projectId: string;
  materialId: string;
  contextId: string;
  level: '提示' | '关注' | '高';
  reason: string;
  samples: number;
  references: { projectId: string; projectName: string; ratio: number }[];
  missing: string[];
  estimatedExcess: number | null;
  estimatedCost: number | null;
  basis: string;
  current: number | null;
  median: number | null;
  mean: number | null;
  lower: number | null;
  upper: number | null;
  probability: null;
  suggestions: string[];
};
const quantile = (a: number[], p: number) => {
  const at = (a.length - 1) * p,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return a[lo] + (a[hi] - a[lo]) * (at - lo);
};
export function materialAnalysis(state: MaterialState, data: Data) {
  const inv = inventory(state.events),
    projectMap = new Map(state.projects.map((p) => [p.projectId, p]));
  const signature = (c: MaterialContext) => {
    const p = projectMap.get(c.projectId);
    return JSON.stringify([
      c.materialId,
      c.phase,
      c.basisKind,
      c.basisKind === 'area_coats' ? c.coats : 1,
      c.process,
      c.paving,
      p?.projectType,
      p?.layout,
      p?.grade,
      p?.design,
    ]);
  };
  const basis = (c: MaterialContext) =>
    (Number(milli(c.basis)) / 1000) * (c.basisKind === 'area_coats' ? c.coats : 1);
  const missing = (c: MaterialContext) => {
    const a: string[] = [];
    if (!projectMap.has(c.projectId)) a.push('项目比较条件');
    else if (Number(projectMap.get(c.projectId)!.constructionArea) <= 0)
      a.push('实际施工面积待核实');
    if (!basis(c)) a.push('有效施工基数');
    if (!c.finalized || c.progress !== 100) a.push('未完成核算');
    const s = inv.stocks.get(stockKey(c.projectId, c.materialId));
    if ([...(s?.counts.values() ?? [])].some((v) => v.difference)) a.push('未核实盘点差异');
    if ((s?.crews.get(c.id)?.qty ?? 0n) > 0n) a.push('班组余料未退回');
    const project = data.projects.find((p) => p.id === c.projectId);
    if (!project) a.push('原项目已移除');
    if (
      (c.tradeId && !data.trades.some((t) => t.id === c.tradeId && t.projectId === c.projectId)) ||
      (c.taskId &&
        !data.tasks.some(
          (t) =>
            t.id === c.taskId &&
            t.projectId === c.projectId &&
            (!c.tradeId || t.tradeId === c.tradeId),
        ))
    )
      a.push('施工关联待复核');
    if (
      c.finalized &&
      project &&
      !isHistorical(project) &&
      !data.tasks.some(
        (t) => t.id === c.taskId && t.projectId === c.projectId && t.status === '已完成',
      )
    )
      a.push('任务或项目完工状态待复核');
    return a;
  };
  const risks: Risk[] = [],
    rows = state.contexts.map((c) => {
      const use = inv.contextUse.get(c.id) ?? { used: 0n, loss: 0n, cost: 0n },
        actual = Number(use.used + use.loss) / 1000,
        denom = basis(c),
        current = denom > 0 ? actual / denom : null;
      const refs = new Map<
        string,
        { projectId: string; projectName: string; amount: number; basis: number; cost: number }
      >();
      for (const h of state.contexts) {
        if (h.projectId === c.projectId || signature(h) !== signature(c) || missing(h).length)
          continue;
        const value = inv.contextUse.get(h.id);
        if (!value || value.used + value.loss <= 0n) continue;
        const r = refs.get(h.projectId) ?? {
          projectId: h.projectId,
          projectName: h.projectName,
          amount: 0,
          basis: 0,
          cost: 0,
        };
        r.amount += Number(value.used + value.loss) / 1000;
        r.basis += basis(h);
        r.cost += Number(value.cost) / 1e6;
        refs.set(h.projectId, r);
      }
      const references = [...refs.values()].map((r) => ({
          projectId: r.projectId,
          projectName: r.projectName,
          ratio: r.amount / r.basis,
          unitCost: r.cost / r.basis,
        })),
        values = references.map((r) => r.ratio).sort((a, b) => a - b),
        enough = values.length >= 5;
      const median = enough ? quantile(values, 0.5) : null,
        mean = enough ? values.reduce((a, b) => a + b, 0) / values.length : null,
        q1 = enough ? quantile(values, 0.25) : 0,
        q3 = enough ? quantile(values, 0.75) : 0,
        spread = q3 - q1,
        lower = enough ? Math.max(0, q1 - 1.5 * spread) : null,
        upper = enough ? q3 + 1.5 * spread : null;
      const budget = Number(milli(c.budgetQty)) / 1000,
        projected = c.progress >= 20 ? (actual * 100) / c.progress : null,
        excess =
          upper !== null && projected !== null ? Math.max(0, projected - upper * denom) : null;
      const ownMissing = missing(c).filter(
          (x) => x !== '未完成核算' && !(x === '班组余料未退回' && !c.finalized),
        ),
        reason = ownMissing.length
          ? '数据未完整，不进行历史风险判断' +
            (!enough ? '；同类历史项目不足5个，不提供区间或概率' : '')
          : !enough
            ? '同类历史项目不足5个，不提供区间或概率'
            : projected === null
              ? '进度不足20%，暂不推算完工用量'
              : excess! > 0
                ? '按当前实际使用与进度推算，超过同类项目四分位距参考上限'
                : '未触发同类项目区间异常';
      const medianCost = enough
        ? quantile(
            references.map((r) => r.unitCost).sort((a, b) => a - b),
            0.5,
          )
        : null;
      const unitCost = denom > 0 ? Number(use.cost) / 1e6 / denom : null;
      const risk: Risk = {
        key: 'usage:' + c.id,
        projectId: c.projectId,
        materialId: c.materialId,
        contextId: c.id,
        level:
          actual > budget && budget > 0
            ? '高'
            : !ownMissing.length && excess! > 0
              ? '关注'
              : '提示',
        reason: actual > budget && budget > 0 ? '已确认使用及损耗超过预算用量；' + reason : reason,
        samples: values.length,
        references,
        missing: ownMissing,
        estimatedExcess: ownMissing.length ? null : excess,
        estimatedCost:
          !ownMissing.length && excess !== null && actual > 0
            ? excess * (Number(use.cost) / 1e6 / actual)
            : null,
        basis:
          c.basisKind === 'area_coats'
            ? '涂刷面积×遍数'
            : c.basisKind === 'length'
              ? '实际布线/施工长度'
              : '实际施工区域面积',
        current,
        median,
        mean,
        lower,
        upper,
        probability: null,
        suggestions: [
          '核对实际施工基数、规格、工艺与设计变更',
          '核对领用、退回、调拨、盘点及切割返工',
          '查看参考项目原始流水，人工复核后再下结论',
        ],
      };
      if ((budget > 0 && actual > budget) || (!ownMissing.length && excess! > 0)) risks.push(risk);
      return {
        ...risk,
        id: c.id,
        projectName: c.projectName,
        phase: c.phase,
        tradeId: c.tradeId,
        teamName: c.teamName,
        basisValue: denom,
        used: decimal(use.used),
        loss: decimal(use.loss),
        actual: decimal(use.used + use.loss),
        actualCost: yuan(use.cost),
        unitBasisCost: denom > 0 ? Number(use.cost) / 1e6 / denom : null,
        unitAreaCost:
          c.basisKind !== 'length' && Number(c.basis) > 0
            ? Number(use.cost) / 1e6 / Number(c.basis)
            : null,
        medianUnitCost: medianCost,
        unitCostDifference: medianCost !== null && unitCost !== null ? unitCost - medianCost : null,
        relativeCost:
          medianCost !== null && medianCost > 0 && unitCost !== null
            ? (unitCost - medianCost) / medianCost
            : null,
        relativeConsumption: median && current !== null ? (current - median) / median : null,
        quantityVariance: actual - budget,

        budgetQty: c.budgetQty,
        costVariance: yuan(use.cost - milli(c.budgetQty) * cents(c.budgetPrice) * 10n),
        lossRate: actual > 0 ? Number(use.loss) / 1000 / actual : null,
        progress: c.progress,
        complete: c.finalized,
      };
    });
  for (const s of inv.stocks.values())
    for (const [location, count] of s.counts)
      if (count.difference)
        risks.push({
          key: 'count:' + count.id,
          projectId: s.projectId,
          materialId: s.materialId,
          contextId: location === 'site' ? '' : location,
          level: '关注',
          reason: '盘点账实差异 ' + decimal(count.difference) + '，未自动视为损耗',
          samples: 0,
          references: [],
          missing: ['盘点差异待核实'],
          estimatedExcess: null,
          estimatedCost: null,
          basis: '库存流水与实盘对照',
          current: null,
          median: null,
          mean: null,
          lower: null,
          upper: null,
          probability: null,
          suggestions: [
            '核对单位、领用退回、未记入场及跨项目调拨',
            '确认原因后关联本次盘点核销或盘盈入账，不自动扣款',
          ],
        });
  return { stocks: [...inv.stocks.values()].map(stockDTO), rows, risks };
}
export function csvRows(rows: unknown[][]) {
  const cell = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

export function materialPeriod(events: MaterialEvent[], from: string, to: string) {
  const before = inventory(events.filter((e) => e.date < from)).stocks,
    after = inventory(events.filter((e) => e.date <= to)).stocks;
  const total = (s: Stock | undefined) =>
    s ? s.site.qty + [...s.crews.values()].reduce((n, b) => n + b.qty, 0n) : 0n;
  return [...new Set([...before.keys(), ...after.keys()])].map((key) => {
    const a = before.get(key),
      b = after.get(key)!;
    const change = (
      k:
        | 'opening'
        | 'adjustment'
        | 'received'
        | 'transferIn'
        | 'transferOut'
        | 'vendorReturn'
        | 'used'
        | 'loss'
        | 'issued'
        | 'returned',
    ) => (b?.[k] ?? 0n) - (a?.[k] ?? 0n);
    const expected =
      total(a) +
      change('opening') +
      change('received') +
      change('transferIn') -
      change('transferOut') -
      change('vendorReturn') -
      change('used') -
      change('loss') +
      change('adjustment');
    const counts = [...b.counts.values()];
    const measured =
      counts.length &&
      counts.every((c) => c.date === to) &&
      b.counts.has('site') &&
      [...b.crews].every(([id, crew]) => crew.qty === 0n || b.counts.has(id))
        ? decimal(counts.reduce((n, c) => n + c.physical, 0n))
        : null;
    return {
      projectId: b.projectId,
      materialId: b.materialId,
      begin: decimal(total(a)),
      endBook: decimal(total(b)),
      endPhysical: measured,
      opening: decimal(change('opening')),
      received: decimal(change('received')),
      issued: decimal(change('issued')),
      returned: decimal(change('returned')),
      transferIn: decimal(change('transferIn')),
      transferOut: decimal(change('transferOut')),
      supplierReturn: decimal(change('vendorReturn')),
      used: decimal(change('used')),
      loss: decimal(change('loss')),
      adjustment: decimal(change('adjustment')),
      check: expected === total(b),
      unverified: decimal(
        counts.reduce((n, c) => n + (c.difference < 0n ? -c.difference : c.difference), 0n),
      ),
    };
  });
}
