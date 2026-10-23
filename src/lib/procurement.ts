import {
  dateOK,
  parseBackup,
  prepareWorkspace,
  purchaseCeiling,
  purchaseDue,
  purchaseSchema,
  type Data,
  type Purchase,
} from './model';

/** A normal edit may never replace its own deadline ceiling or confirmation history. */
export function savePurchase(data: Data, value: Purchase): Data {
  const base = prepareWorkspace(data),
    old = base.purchases.find((p) => p.id === value.id);
  if (!base.projects.some((p) => p.id === value.projectId)) throw new Error('请选择有效的所属项目');
  if (old && old.projectId !== value.projectId) throw new Error('已有采购不能通过普通编辑迁移项目');
  const deadline = value.due;
  let next: Purchase;
  if (old) {
    const ceiling = purchaseCeiling(old, base);
    // If an unchanged linked record is saved, preserve automatic early-date calculation.
    const changedDate = deadline !== purchaseDue(old, base);
    if (changedDate && deadline > ceiling)
      throw new Error(`采购截止不能晚于原定或已确认期限 ${ceiling}，请使用“变更原定期限”`);
    next = {
      ...old,
      ...value,
      originalDue: old.originalDue,
      approvedDue: old.approvedDue,
      deadlineHistory: old.deadlineHistory,
      deadlineMode: changedDate ? 'fixed' : old.deadlineMode,
      due: changedDate || old.deadlineMode === 'fixed' ? deadline : old.due,
      taskId: old.taskId,
      leadDays: old.leadDays,
    };
  } else {
    next = { ...value, taskId: '', leadDays: 0, originalDue: deadline, deadlineMode: 'fixed' };
    delete next.approvedDue;
    delete next.deadlineHistory;
  }
  const valid = purchaseSchema.parse(next);
  const result = {
    ...base,
    purchases: old
      ? base.purchases.map((p) => (p.id === valid.id ? valid : p))
      : [...base.purchases, valid],
  };
  parseBackup(result);
  return result;
}
export function confirmPurchaseDeadline(
  data: Data,
  purchaseId: string,
  deadline: string,
  reason: string,
): Data {
  const base = prepareWorkspace(data),
    p = base.purchases.find((x) => x.id === purchaseId);
  if (!p || !dateOK(deadline) || !reason.trim() || reason.trim().length > 4000)
    throw new Error('请填写有效的新期限和变更原因');
  const previous = purchaseCeiling(p, base);
  if (deadline === previous) throw new Error('新期限与当前约束相同');
  const changed: Purchase = {
    ...p,
    due: deadline,
    deadlineMode: 'fixed',
    approvedDue: deadline,
    deadlineHistory: [
      ...(p.deadlineHistory ?? []),
      { from: previous, to: deadline, reason: reason.trim(), at: new Date().toISOString() },
    ],
  };
  const next = { ...base, purchases: base.purchases.map((x) => (x.id === p.id ? changed : x)) };
  parseBackup(next);
  return next;
}
