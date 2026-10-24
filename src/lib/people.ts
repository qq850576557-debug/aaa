import type { Data, Personnel } from './model';
export function assignedNames(
  data: Data,
  item: { staffIds?: string[]; personnel?: Personnel; manager?: string; owner?: string },
  role: '施工人员' | '项目经理' | '设计人员' | '监理',
) {
  const names = (data.people ?? [])
    .filter((p) => item.staffIds?.includes(p.id) && p.role === role)
    .map((p) => p.name);
  const legacy =
    role === '施工人员'
      ? (item.personnel?.worker ?? item.owner)
      : role === '项目经理'
        ? (item.personnel?.manager ?? item.manager)
        : role === '设计人员'
          ? item.personnel?.designer
          : '';
  return [...new Set(names.length ? names : legacy ? [legacy] : [])].join('、');
}
