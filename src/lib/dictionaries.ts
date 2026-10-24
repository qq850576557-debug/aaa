import { parseBackup, type Data, type DictionaryItem, type Person } from './model';
export function dictionaryReferences(data: Data, id: string) {
  return (data.people ?? []).filter((p) => p.categoryId === id || p.tradeIds?.includes(id));
}
export function saveDictionary(data: Data, item: DictionaryItem): Data {
  if (
    (data.dictionaries ?? []).some(
      (x) =>
        x.id !== item.id &&
        x.kind === item.kind &&
        !x.deleted &&
        x.label.trim() === item.label.trim(),
    )
  )
    throw Error('同类字典中已有同名选项');
  const prior = data.dictionaries?.find((x) => x.id === item.id);
  if (prior && prior.kind !== item.kind) throw Error('不能变更字典种类');
  return parseBackup({
    ...data,
    dictionaries: prior
      ? data.dictionaries!.map((x) => (x.id === item.id ? item : x))
      : [...(data.dictionaries ?? []), item],
  });
}
export function deleteDictionary(data: Data, id: string) {
  const x = data.dictionaries?.find((x) => x.id === id);
  if (!x) throw Error('选项不存在');
  if (dictionaryReferences(data, id).length)
    throw Error('已有人员引用此选项，请停用；原资料及历史不会删除');
  return saveDictionary(data, { ...x, active: false, deleted: true });
}
export const categoryName = (d: Data, p: Person) =>
  d.dictionaries?.find((x) => x.id === p.categoryId)?.label ?? p.role;
export const tradeNames = (d: Data, p: Person) =>
  p.tradeIds?.length
    ? p.tradeIds.map((id) => d.dictionaries?.find((x) => x.id === id)?.label ?? id).join('、')
    : p.trade;
