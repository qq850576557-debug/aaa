import { businessUndo } from './undo-manager';
import { checkFields, type CheckField, type CheckStatus } from './assessments';
import type { AssessmentTarget } from './assessment-sync';
export function rememberAssessment(
  target: AssessmentTarget,
  before: Partial<Record<CheckField, CheckStatus>>,
  after: Partial<Record<CheckField, CheckStatus>>,
) {
  const scope = businessUndo.scope,
    generation = businessUndo.generation;
  const guard = () => {
    if (scope !== businessUndo.scope || generation !== businessUndo.generation)
      throw Error('账号或编辑会话已切换');
  };
  const fields = checkFields.filter(
    (f) =>
      after[f] !== undefined &&
      (before[f] !== after[f] || target.sources.some((r) => r[f] !== after[f])),
  );
  if (!fields.length) return;
  const apply = async (
    values: Partial<Record<CheckField, CheckStatus>>,
    expected: Partial<Record<CheckField, CheckStatus>>,
  ) => {
    guard();
    const { assessmentDrafts, setAssessmentIntent } = await import('./assessment-sync');
    const { cloudApi } = await import('./cloud');
    const { dailyKey } = await import('./assessments');
    const drafts = await assessmentDrafts();
    const draft = drafts.find((d) => dailyKey(d.target) === dailyKey(target));
    if (draft?.blocked) throw Error('此考核存在待核对冲突，先处理原保存；不会覆盖其他人的修改。');
    let sources = draft?.target.sources ?? target.sources;
    if (navigator.onLine && !draft) {
      const result = await cloudApi<{ records: import('./assessments').Assessment[] }>(
        `/assessments?from=${target.date}&to=${target.date}`,
      );
      const ids = new Set(target.sources.map((r) => r.personId));
      ids.add(target.personId);
      sources = result.records.filter(
        (r) => r.projectId === target.projectId && ids.has(r.personId),
      );
    }
    for (const f of fields) {
      const values = sources.map((r) => r[f]);
      const current = draft?.fields[f]?.value ?? (values.length ? values[0] : 'pending');
      if (current !== expected[f] || values.some((v) => v !== values[0]))
        throw Error('该考核已有后续修改，请核对当前状态；未覆盖云端。');
    }
    guard();
    await setAssessmentIntent(
      { ...target, sources },
      Object.fromEntries(fields.map((f) => [f, values[f]])),
      false,
    );
  };
  const legacy = fields.some((f) => new Set(target.sources.map((r) => r[f])).size > 1);
  const replaySources = async (reverse: boolean) => {
    guard();
    const { verifiedOwner } = await import('./record-outbox');
    const owner = verifiedOwner();
    const { cloudApi, queueCloudRecord } = await import('./cloud');
    const { assessmentDrafts } = await import('./assessment-sync');
    const { dailyKey } = await import('./assessments');
    if ((await assessmentDrafts()).some((d) => dailyKey(d.target) === dailyKey(target)))
      throw Error('请等待前序考核保存完成，再撤销旧工种来源。');
    const { records } = await cloudApi<{ records: import('./assessments').Assessment[] }>(
      `/assessments?from=${target.date}&to=${target.date}`,
    );
    const edits = target.sources.map((old) => {
      const current = records.find((r) => r.id === old.id);
      if (!current) throw Error('原考核来源已变化，请核对历史');
      for (const f of fields)
        if (current[f] !== (reverse ? after[f] : old[f]))
          throw Error('旧考核来源已有后续修改，未覆盖当前记录');
      return {
        date: old.date,
        personId: old.personId,
        projectId: old.projectId,
        tradeId: old.tradeId,
        version: current.version,
        changes: Object.fromEntries(fields.map((f) => [f, reverse ? old[f] : after[f]])),
      };
    });
    guard();
    const q = await queueCloudRecord('/assessments/batch', 'POST', {
      requestId: crypto.randomUUID(),
      confirmed: true,
      edits,
    });
    const values = Object.fromEntries(
      fields.map((f) => {
        const known = new Set(edits.map((e) => e.changes[f]));
        return [f, known.size === 1 ? [...known][0] : 'pending'];
      }),
    );
    window.dispatchEvent(
      new CustomEvent('chunmo-assessment-undo-preview', {
        detail: { key: dailyKey(target), values, owner },
      }),
    );
    try {
      const result = await q.completion;
      window.dispatchEvent(
        new CustomEvent('chunmo-assessment-confirmed', {
          detail: { records: result.records, owner },
        }),
      );
    } finally {
      window.dispatchEvent(
        new CustomEvent('chunmo-assessment-undo-preview', {
          detail: { key: dailyKey(target), values: {}, owner },
        }),
      );
    }
  };
  businessUndo.push({
    label: '师傅每日考核',
    undo: () => (legacy ? replaySources(true) : apply(before, after)),
    redo: () => (legacy ? replaySources(false) : apply(after, before)),
  });
}
