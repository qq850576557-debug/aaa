import { describe, it, expect } from 'vitest';
import {
  copyProject,
  defaultTrades,
  emptyData,
  id,
  newProject,
  parseBackup,
  type Task,
} from './model';
import { proposeTaskChange, reorderTrades } from './scheduling';
function setup() {
  const d = emptyData(),
    p = newProject();
  p.name = '测试项目';
  p.start = '2026-12-20';
  p.end = '2027-01-31';
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  const t = (name: string, start: string, end: string, order = 0): Task => ({
    id: id(),
    projectId: p.id,
    tradeId: d.trades[order].id,
    name,
    start,
    end,
    status: '未开始',
    owner: '',
    notes: '',
  });
  return { d, p, t };
}
describe('atomic schedule changes', () => {
  it('accepts old v1 backups without migration or group fields', () => {
    const { d, t } = setup();
    d.tasks = [t('旧任务', '2026-12-22', '2026-12-25')];
    expect(parseBackup(d)).toEqual(d);
  });
  it('merges only linked adjacent segments and preserves/remaps records', () => {
    const { d, t } = setup();
    const a = t('铺贴', '2026-12-22', '2026-12-25'),
      b = { ...t('铺贴', '2026-12-30', '2027-01-02'), groupId: a.id },
      c = t('铺贴', '2026-12-26', '2026-12-28');
    d.tasks = [a, b, c];
    d.purchases = [
      {
        id: id(),
        projectId: a.projectId,
        name: '砖',
        taskId: a.id,
        due: '2026-12-22',
        leadDays: 2,
        status: '待采购',
        notes: '',
        owner: '',
      },
    ];
    const plan = proposeTaskChange(d, { ...b, start: '2026-12-26', end: '2026-12-29' });
    expect(plan.current.tasks).toHaveLength(2);
    expect(plan.current.tasks.find((t) => t.id === b.id)?.start).toBe('2026-12-22');
    expect(plan.current.purchases[0].taskId).toBe(b.id);
    expect(plan.base.tasks).toHaveLength(3);
  });
  it('propagates explicit dependencies over year boundary, preserving durations and independent overlaps', () => {
    const { d, t } = setup();
    const a = t('拆改', '2026-12-25', '2026-12-29'),
      b = { ...t('水电', '2026-12-30', '2027-01-02', 1), dependsOn: [a.id] },
      c = { ...t('试验', '2027-01-03', '2027-01-04', 2), dependsOn: [b.id] },
      overlap = t('交叉作业', '2026-12-28', '2027-01-02', 3);
    d.tasks = [a, b, c, overlap];
    const plan = proposeTaskChange(d, { ...a, end: '2027-01-01' });
    expect(plan.affected).toHaveLength(2);
    expect(plan.shifted.tasks.find((t) => t.id === b.id)?.end).toBe('2027-01-05');
    expect(plan.shifted.tasks.find((t) => t.id === c.id)?.start).toBe('2027-01-06');
    expect(plan.shifted.tasks.find((t) => t.id === overlap.id)).toEqual(overlap);
    expect(plan.current.tasks.find((t) => t.id === b.id)).toEqual(b);
    expect(d.tasks[0]).toEqual(a);
  });
  it('uses conservative order heuristic and does not reschedule completed or preexisting overlapping tasks', () => {
    const { d, t } = setup();
    const a = t('拆改', '2026-12-25', '2026-12-27'),
      b = t('水电', '2026-12-28', '2026-12-30', 1),
      overlap = t('木工', '2026-12-26', '2026-12-29', 4),
      done = { ...t('已验收', '2026-12-28', '2026-12-28', 7), status: '已完成' as const };
    d.tasks = [a, b, overlap, done];
    const plan = proposeTaskChange(d, { ...a, end: '2026-12-29' });
    expect(plan.inferred).toBe(true);
    expect(plan.affected.map((x) => x.after.id)).toEqual([b.id]);
  });
  it('rejects cycles and cross-project dependencies', () => {
    const { d, t } = setup();
    const a = t('a', '2026-12-25', '2026-12-27'),
      b = t('b', '2026-12-28', '2026-12-29', 1);
    d.tasks = [
      { ...a, dependsOn: [b.id] },
      { ...b, dependsOn: [a.id] },
    ];
    expect(() => parseBackup(d)).toThrow('循环');
  });
  it('reorders trades without changing any task dates', () => {
    const { d, t, p } = setup();
    d.tasks = [t('拆改', '2026-12-25', '2026-12-27')];
    const n = reorderTrades(d, p.id, d.trades[2].id, d.trades[0].id);
    expect(n.trades.find((t) => t.id === d.trades[2].id)?.order).toBe(0);
    expect(n.tasks).toEqual(d.tasks);
  });
});

describe('copying new optional fields', () => {
  it('remaps logical groups, dependencies and linked notes without cross-project links', () => {
    const { d, p, t } = setup(),
      root = t('拆改', '2026-12-22', '2026-12-25'),
      segment = { ...t('二段', '2026-12-28', '2026-12-29'), groupId: root.id },
      child = { ...t('水电', '2026-12-30', '2027-01-02', 1), dependsOn: [root.id] };
    d.tasks = [root, segment, child];
    d.notes = [
      {
        id: id(),
        projectId: p.id,
        title: '任务备忘',
        kind: '项目备忘',
        date: '',
        reminder: '',
        owner: '',
        content: '保留现场信息',
        done: false,
        pinned: false,
        taskId: segment.id,
      },
    ];
    const result = copyProject(d, p);
    const copyRoot = result.data.tasks.find(
        (x) => x.projectId === result.project.id && x.name === root.name,
      )!,
      copySegment = result.data.tasks.find(
        (x) => x.projectId === result.project.id && x.name === segment.name,
      )!;
    expect(copySegment.groupId).toBe(copyRoot.id);
    expect(
      result.data.tasks.find((x) => x.projectId === result.project.id && x.name === child.name)
        ?.dependsOn,
    ).toEqual([copyRoot.id]);
    expect(result.data.notes.find((x) => x.projectId === result.project.id)?.taskId).toBe(
      copySegment.id,
    );
    expect(() => parseBackup(result.data)).not.toThrow();
  });
});

describe('review regressions: merged predecessors and unsupported shift ranges', () => {
  it('detects growth of a retired predecessor after dependency remapping', () => {
    const { d, t } = setup();
    const root = t('原始段', '2026-12-22', '2026-12-25'),
      segment = { ...t('后续段', '2026-12-28', '2026-12-29'), groupId: root.id },
      dependent = { ...t('水电', '2026-12-26', '2026-12-28', 1), dependsOn: [root.id] };
    d.tasks = [root, segment, dependent];
    const plan = proposeTaskChange(d, { ...segment, start: '2026-12-26', end: '2026-12-27' });
    expect(plan.mergedIds).toEqual([root.id]);
    expect(plan.current.tasks.find((x) => x.id === dependent.id)?.dependsOn).toEqual([segment.id]);
    expect(plan.affected.map((x) => x.after.id)).toEqual([dependent.id]);
    expect(plan.shifted.tasks.find((x) => x.id === dependent.id)?.start).toBe('2026-12-28');
    expect(plan.base).toEqual(d);
  });
  it('keeps current-only changes valid when the proposed downstream shift exceeds 2200', () => {
    const { d, p, t } = setup();
    p.start = '2200-12-20';
    p.end = '2200-12-31';
    const a = t('前序', '2200-12-28', '2200-12-29'),
      b = { ...t('后序', '2200-12-30', '2200-12-31', 1), dependsOn: [a.id] };
    d.tasks = [a, b];
    const plan = proposeTaskChange(d, { ...a, end: '2200-12-31' });
    expect(plan.shiftError).toContain('日期无效');
    expect(() => parseBackup(plan.current)).not.toThrow();
    expect(plan.current.tasks[1]).toEqual(b);
    expect(d.tasks[0].end).toBe('2200-12-29');
  });
  it('does not infer a delay for a dependent whose own referenced segment became earlier', () => {
    const { d, t } = setup();
    const root = t('早段', '2026-12-22', '2026-12-25'),
      segment = { ...t('晚段', '2026-12-28', '2026-12-29'), groupId: root.id },
      dependent = { ...t('后序', '2026-12-30', '2027-01-01', 1), dependsOn: [segment.id] };
    d.tasks = [root, segment, dependent];
    const plan = proposeTaskChange(d, { ...segment, start: '2026-12-26', end: '2026-12-27' });
    expect(plan.affected).toEqual([]);
    expect(plan.shifted.tasks.find((x) => x.id === dependent.id)).toEqual(dependent);
  });
});
