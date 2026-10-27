import { z } from 'zod';
import { dateOK, type Data } from './model';
export const checkStatus = z.enum(['pending', 'yes', 'no']);
export type CheckStatus = z.infer<typeof checkStatus>;
export const checkFields = ['attendance', 'photo', 'cleaning'] as const;
export type CheckField = (typeof checkFields)[number];
export const checkLabels = { attendance: '今日签到', photo: '下班拍照', cleaning: '下班卫生' };
export const statusLabel = (field: CheckField, value: CheckStatus) =>
  value === 'pending'
    ? '待记录'
    : field === 'attendance'
      ? value === 'yes'
        ? '已签到'
        : '未签到'
      : field === 'photo'
        ? value === 'yes'
          ? '已拍照'
          : '未拍照'
        : value === 'yes'
          ? '已打扫'
          : '未打扫';
export const daySchema = z.string().refine(dateOK, '日期无效');
const identity = z.string().min(1).max(100);
export const assessmentKey = z
  .object({ date: daySchema, personId: identity, projectId: identity, tradeId: identity })
  .strict();
export type AssessmentKey = z.infer<typeof assessmentKey>;
export const assessmentEdit = assessmentKey
  .extend({
    version: z.number().int().nonnegative(),
    changes: z
      .object({
        attendance: checkStatus.optional(),
        photo: checkStatus.optional(),
        cleaning: checkStatus.optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0),
  })
  .strict();
export type AssessmentEdit = z.infer<typeof assessmentEdit>;
export type Assessment = AssessmentKey & {
  id: string;
  version: number;
  personName: string;
  projectName: string;
  tradeName: string;
  attendance: CheckStatus;
  photo: CheckStatus;
  cleaning: CheckStatus;
  createdBy: string;
  createdName: string;
  createdAt: string;
  updatedBy: string;
  updatedName: string;
  updatedAt: string;
};
export const keyOf = (r: AssessmentKey) =>
  JSON.stringify([r.date, r.personId, r.projectId, r.tradeId]);
// Only real assigned personnel/trades are offered, not fabricated daily records.
export function assessmentCandidates(data: Data, date: string): AssessmentKey[] {
  const result: AssessmentKey[] = [];
  for (const g of data.trades) {
    const project = data.projects.find((p) => p.id === g.projectId);
    if (!project) continue;
    const ids = new Set([
      ...(project.staffIds ?? []),
      ...(g.staffIds ?? []),
      ...data.tasks
        .filter((t) => t.projectId === g.projectId && t.tradeId === g.id)
        .flatMap((t) => t.staffIds ?? []),
    ]);
    for (const p of data.people ?? [])
      if (ids.has(p.id) && !p.deleted && p.active && p.role === '施工人员')
        result.push({ date, personId: p.id, projectId: project.id, tradeId: g.id });
  }
  return result;
}
export function assessmentStats(rows: Assessment[]) {
  const map = new Map<
    string,
    {
      personId: string;
      personName: string;
      projectId: string;
      projectName: string;
      total: number;
      counts: Record<CheckField, Record<CheckStatus, number>>;
    }
  >();
  for (const r of rows) {
    const key = JSON.stringify([r.personId, r.projectId]);
    let value = map.get(key);
    if (!value) {
      value = {
        personId: r.personId,
        personName: r.personName,
        projectId: r.projectId,
        projectName: r.projectName,
        total: 0,
        counts: {
          attendance: { pending: 0, yes: 0, no: 0 },
          photo: { pending: 0, yes: 0, no: 0 },
          cleaning: { pending: 0, yes: 0, no: 0 },
        },
      };
      map.set(key, value);
    }
    value.total++;
    for (const f of checkFields) value.counts[f][r[f]]++;
  }
  return [...map.values()];
}
export function assessmentCSV(rows: Assessment[]) {
  // Neutralize spreadsheet formulas, quote every value and emit BOM for Excel.
  const cell = (s: string) =>
    '"' + (/^[\s]*[=+\-@]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"';
  const lines = [
    [
      '日期',
      '师傅',
      '项目',
      '工种',
      '今日签到',
      '下班拍照',
      '下班卫生',
      '首次记录人',
      '首次记录时间',
      '最后修改人',
      '最后修改时间',
    ],
    ...rows.map((r) => [
      r.date,
      r.personName,
      r.projectName,
      r.tradeName,
      ...checkFields.map((f) => statusLabel(f, r[f])),
      r.createdName,
      r.createdAt,
      r.updatedName,
      r.updatedAt,
    ]),
  ];
  return '\ufeff' + lines.map((row) => row.map(cell).join(',')).join('\r\n');
}
