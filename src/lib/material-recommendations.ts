import { materialAnalysis, inventory, type MaterialState } from './materials';
import { type Data, isHistorical } from './model';
export function transferSuggestions(state: MaterialState, data: Data, sourceProject: string) {
  const a = materialAnalysis(state, data),
    holding = inventory(state.events).transit;
  const pending = (pid: string, mid: string) =>
    state.contexts
      .filter((c) => c.projectId === pid && c.materialId === mid && !c.finalized)
      .reduce(
        (n, c) =>
          n +
          Math.max(0, Number(c.budgetQty) - Number(a.rows.find((r) => r.id === c.id)?.actual ?? 0)),
        0,
      );
  const incoming = (pid: string, mid: string) =>
    [...holding].reduce((n, [id, b]) => {
      const dispatch = state.events.find(
        (e) => e.kind === 'transfer_dispatch' && e.referenceId === id,
      );
      return (
        n +
        (dispatch?.targetProjectId === pid && dispatch.materialId === mid
          ? Number(b.qty) / 1000
          : 0)
      );
    }, 0);
  return a.stocks
    .filter((s) => s.projectId === sourceProject && !s.closed)
    .flatMap((s) => {
      const reserve = Math.max(0, pending(s.projectId, s.materialId) - Number(s.crewQty)),
        available = Math.max(0, Number(s.siteQty) - reserve),
        rate = state.projects.find((p) => p.projectId === s.projectId)?.transportRate;
      if (!available) return [];
      const seen = new Set<string>();
      let remaining = available;
      return state.contexts
        .filter(
          (c) =>
            c.projectId !== sourceProject &&
            data.projects.some((p) => p.id === c.projectId && !isHistorical(p)) &&
            c.materialId === s.materialId &&
            !c.finalized &&
            c.progress < 100,
        )
        .sort((a, b) =>
          (data.tasks.find((t) => t.id === a.taskId)?.start || '9999').localeCompare(
            data.tasks.find((t) => t.id === b.taskId)?.start || '9999',
          ),
        )
        .flatMap((c) => {
          if (seen.has(c.projectId)) return [];
          seen.add(c.projectId);
          const stock = a.stocks.find(
            (x) => x.projectId === c.projectId && x.materialId === s.materialId,
          );
          if (stock?.closed) return [];
          const inTransit = incoming(c.projectId, c.materialId),
            need = Math.max(
              0,
              pending(c.projectId, c.materialId) - Number(stock?.totalQty ?? 0) - inTransit,
            ),
            quantity = Math.min(remaining, need);
          if (!quantity) return [];
          remaining -= quantity;
          const transportCost = rate === undefined ? null : Number(rate) * quantity,
            unitValue = Number(s.siteQty) > 0 ? Number(s.value) / Number(s.siteQty) : 0;
          return [
            {
              sourceProject,
              context: c,
              materialId: s.materialId,
              reserve,
              available,
              need,
              quantity,
              inTransit,
              start: data.tasks.find((t) => t.id === c.taskId)?.start ?? '',
              transportCost,
              checks: [
                '核对材料质量与可复用状态',
                '核对来源后续预算和设计变更',
                ...(transportCost !== null && unitValue > 0 && Number(rate) >= unitValue
                  ? ['运输估算接近或超过账面材料价值，需比较就近采购']
                  : []),
                '核对运输搬运成本，建议不自动执行',
              ],
            },
          ];
        });
    });
}
