import { z } from 'zod';
import { dateOK } from './model';

export const recordStatuses = [
  '待执行',
  '进行中',
  '持续跟进',
  '待备料',
  '紧急',
  '已完成',
  '已取消',
] as const;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), '请勿输入控制字符');
export const recordValue = z
  .object({
    mentionIds: z
      .array(z.string().min(1).max(100))
      .max(50)
      .refine((x) => new Set(x).size === x.length, '请勿重复选择账号')
      .optional(),
    projectId: z.string().min(1).max(100),
    title: text(240).trim().min(1, '请填写任务事项'),
    nodeDate: z
      .string()
      .refine(
        (v) => v === '' || (dateOK(v) && v >= '1900-01-01' && v <= '2200-12-31'),
        '节点日期无效',
      ),
    status: z.enum(recordStatuses),
    notes: text(4000),
    followUp: text(4000),
    owner: text(100).optional(),
  })
  .strict();
export const recordCreate = z
  .object({
    requestId: z.uuid(),
    value: recordValue.extend({
      nodeDate: z
        .string()
        .refine(
          (v) => dateOK(v) && v >= '1900-01-01' && v <= '2200-12-31',
          '请选择有效的事项处理日期',
        ),
    }),
  })
  .strict();
// Historical undated records remain readable/recoverable; do not rewrite them on upgrade.
export const recordUpdate = z
  .object({
    requestId: z.uuid(),
    value: recordValue,
    restore: z.literal(true).optional(),
    version: z.number().int().min(1),
  })
  .strict();
export const recordDelete = z
  .object({ requestId: z.uuid(), version: z.number().int().min(1) })
  .strict();
export type RecordValue = z.infer<typeof recordValue>;
export type WorkRecord = RecordValue & {
  id: string;
  version: number;
  projectName: string;
  deleted: boolean;
  createdBy: string;
  createdName: string;
  createdAt: string;
  updatedBy: string;
  updatedName: string;
  updatedAt: string;
};
export type RecordHistory = {
  id: string;
  actorId: string;
  actorName: string;
  at: string;
  operation: 'create' | 'update' | 'delete';
  changedFields: string[];
  before: { status: string; nodeDate: string; projectId: string } | null;
  after: { status: string; nodeDate: string; projectId: string } | null;
};
export const recordFields: Record<string, string> = {
  projectId: '项目',
  title: '任务事项',
  nodeDate: '节点日期',
  status: '状态',
  notes: '备注',
  followUp: '跟进',
  owner: '负责人',
  mentionIds: '@负责人',
  deleted: '删除状态',
};
export function visibleRecords(
  records: WorkRecord[],
  filters: { project: string; status: string; search: string; sort: string },
) {
  const needle = filters.search.trim().toLocaleLowerCase('zh-CN');
  return records
    .filter(
      (r) =>
        !r.deleted &&
        (!filters.project || r.projectId === filters.project) &&
        (!filters.status || r.status === filters.status) &&
        (!needle ||
          [r.title, r.projectName, r.notes, r.followUp, r.owner || ''].some((s) =>
            s.toLocaleLowerCase('zh-CN').includes(needle),
          )),
    )
    .sort((a, b) => {
      if (filters.sort === 'updated')
        return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      if (!a.nodeDate || !b.nodeDate)
        return a.nodeDate ? -1 : b.nodeDate ? 1 : a.id.localeCompare(b.id);
      return (
        (filters.sort === 'dateDesc' ? -1 : 1) * a.nodeDate.localeCompare(b.nodeDate) ||
        a.id.localeCompare(b.id)
      );
    });
}

export const recordData = (r: WorkRecord): RecordValue => ({
  ...(r.mentionIds ? { mentionIds: r.mentionIds } : {}),
  projectId: r.projectId,
  title: r.title,
  nodeDate: r.nodeDate,
  status: r.status,
  notes: r.notes,
  followUp: r.followUp,
  owner: r.owner ?? '',
});
