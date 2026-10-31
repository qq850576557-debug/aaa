import { projectStageTemplate } from './trade-colors';
import {
  id,
  palette,
  parseBackup,
  tradeNames as stages,
  type Data,
  type DictionaryItem,
} from './model';
import { dictionaryReferences } from './dictionaries';

const defaults = [
  ['demolition', '拆除工'],
  ['electrical', '水电工'],
  ['masonry', '泥工'],
  ['tiling', '瓦工'],
  ['waterproof', '防水工'],
  ['carpentry', '木工'],
  ['painting', '油漆工'],
  ['installation', '安装工'],
];
const synonyms: Record<string, string> = {
  泥水工: '泥工',
  水电师傅: '水电工',
  拆改工: '拆除工',
  木作: '木工',
  木作工: '木工',
  油工: '油漆工',
  漆工: '油漆工',
  安装师傅: '安装工',
};
export const workerTradeName = (label: string) => {
  const name = label.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return Object.hasOwn(synonyms, name) ? synonyms[name] : name;
};
export function workerTradeColor(label: string) {
  const name = workerTradeName(label);
  const fixed = new Map([
    ['拆除工', 0],
    ['水电工', 1],
    ['防水工', 2],
    ['瓦工', 3],
    ['木工', 4],
    ['油漆工', 5],
    ['安装工', 6],
    ['泥工', 7],
  ]);
  const hash = [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  return palette[fixed.get(name) ?? hash % palette.length];
}
const phaseNames = new Set([
  ...stages,
  ...projectStageTemplate.map(([name]) => name),
  '砌墙阶段',
  '木工阶段',
  '油漆阶段',
  '水电阶段',
  '拆除阶段',
  '防水阶段',
  '木工吊顶',
  '墙面油漆',
]);
export function isWorkerTrade(data: Data, item: DictionaryItem) {
  if (item.kind !== 'trade' || item.usage === 'stage' || phaseNames.has(item.label.trim()))
    return false;
  if (
    item.usage === 'worker' ||
    defaults.some(([, label]) => label === workerTradeName(item.label))
  )
    return true;
  return !data.trades.some((s) => s.name.trim() === item.label.trim());
}
/** Virtual defaults have stable IDs. Loading/selecting never writes or deletes old rows. */
export function workerCatalog(data: Data): DictionaryItem[] {
  const stored = data.dictionaries ?? [];
  return [
    ...stored,
    ...defaults.flatMap(([key, label], order) => {
      const keyId = 'worker-default:' + key;
      if (stored.some((x) => x.id === keyId)) return [];
      const prior = stored.find(
        (x) => isWorkerTrade(data, x) && workerTradeName(x.label) === label,
      );
      return [
        {
          id: keyId,
          kind: 'trade' as const,
          usage: 'worker' as const,
          label,
          active: prior?.active ?? true,
          ...(prior?.deleted ? { deleted: true } : {}),
          order: prior?.order ?? order,
        },
      ];
    }),
  ];
}
export type WorkerTradeChoice = DictionaryItem & { ids: string[] };
export function workerTradeChoices(data: Data): WorkerTradeChoice[] {
  const groups = new Map<string, DictionaryItem[]>();
  for (const item of workerCatalog(data)) {
    if (!isWorkerTrade(data, item)) continue;
    const name = workerTradeName(item.label);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([label, members]) => {
      const usable = members.filter((x) => x.active && !x.deleted);
      const candidates = usable.length
        ? usable
        : members.filter((x) => !x.deleted).length
          ? members.filter((x) => !x.deleted)
          : members;
      const representative =
        candidates.find((x) => x.id.startsWith('worker-default:')) || candidates[0];
      return {
        ...representative,
        label,
        active: members.some((x) => x.active && !x.deleted),
        deleted: members.every((x) => x.deleted),
        order: Math.min(...members.map((x) => x.order)),
        ids: members.map((x) => x.id),
      };
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
export const ensureWorkerCatalog = (data: Data): Data => ({
  ...data,
  dictionaries: workerCatalog(data),
});
export function workerReferences(data: Data, ids: string[]) {
  return [
    ...new Map(
      ids.flatMap((key) => dictionaryReferences(data, key)).map((p) => [p.id, p]),
    ).values(),
  ];
}
export function saveWorkerTrade(
  data: Data,
  value: Pick<DictionaryItem, 'label' | 'order' | 'active'>,
  choiceId?: string,
): Data {
  const d = ensureWorkerCatalog(data),
    choices = workerTradeChoices(d),
    old = choices.find((x) => x.id === choiceId);
  const label = workerTradeName(value.label);
  if (!label || label.length > 100) throw Error('请输入1—100字的人员工种名称');
  if (phaseNames.has(label)) throw Error('这是施工阶段，请使用“木工”“安装工”等人员工种名称');
  if (choices.some((x) => !x.deleted && x.id !== choiceId && workerTradeName(x.label) === label))
    throw Error('已有同名或同义工种，请使用现有选项');
  const record: DictionaryItem = {
    id: old?.id || id(),
    kind: 'trade',
    usage: 'worker',
    label,
    order: value.order,
    active: value.active,
  };
  return parseBackup({
    ...d,
    dictionaries: old
      ? d.dictionaries!.map((x) =>
          old.ids.includes(x.id)
            ? {
                ...x,
                label,
                order: value.order,
                active: value.active,
                usage: 'worker',
                deleted: false,
              }
            : x,
        )
      : [...d.dictionaries!, record],
  });
}
export function removeWorkerTrade(data: Data, choiceId: string): Data {
  const d = ensureWorkerCatalog(data),
    item = workerTradeChoices(d).find((x) => x.id === choiceId);
  if (!item) throw Error('工种已不存在，请重新读取');
  const used = workerReferences(d, item.ids).length > 0;
  return parseBackup({
    ...d,
    dictionaries: d.dictionaries!.map((x) =>
      item.ids.includes(x.id) ? { ...x, active: false, ...(!used ? { deleted: true } : {}) } : x,
    ),
  });
}
export function reorderWorkerTrades(data: Data, source: string, before: string | null): Data {
  const d = ensureWorkerCatalog(data),
    items = workerTradeChoices(d).filter((x) => !x.deleted),
    item = items.find((x) => x.id === source);
  if (!item || source === before) return d;
  const rest = items.filter((x) => x.id !== source),
    index = before === null ? rest.length : rest.findIndex((x) => x.id === before);
  if (index < 0) return d;
  rest.splice(index, 0, item);
  const orders = new Map(rest.flatMap((x, i) => x.ids.map((key) => [key, i] as const)));
  return parseBackup({
    ...d,
    dictionaries: d.dictionaries!.map((x) =>
      orders.has(x.id) ? { ...x, order: orders.get(x.id)! } : x,
    ),
  });
}
export function reorderPeople(data: Data, source: string, before: string | null): Data {
  const item = data.people?.find((p) => p.id === source);
  if (!item || source === before) return data;
  const rest = data.people!.filter((p) => p.id !== source),
    index = before === null ? rest.length : rest.findIndex((p) => p.id === before);
  if (index < 0) return data;
  rest.splice(index, 0, item);
  return { ...data, people: rest };
}
