import { canonical } from './history';
import { noteDue, purchaseDue, type Data, type Note } from './model';
import type { WorkRecord } from './records';
export type LegacyKind = 'purchase' | 'record' | 'reference' | 'pending';
export type LegacyLink = {
  sourceKey: string;
  sourceId: string;
  projectId: string;
  sourceHash: string;
  targetKind: string;
  targetId: string | null;
  matchesCurrent?: boolean;
};
export type LegacyCandidate = {
  key: string;
  sourceType: 'note' | 'project';
  projectId: string;
  sourceId: string;
  title: string;
  content: string;
  date: string;
  owner: string;
  done: boolean;
  original: Note | Data['projects'][number];
  kind: LegacyKind;
  reason: string;
  sourceDuplicates?: boolean;
  matches: {
    kind: 'purchase' | 'record';
    id: string;
    exact: boolean;
    date: string;
    owner: string;
    content: string;
    status: string;
    deleted: boolean;
  }[];
};
export const legacyKey = (type: string, projectId: string, id: string) =>
  JSON.stringify([type, projectId, id]);
export function legacyCandidates(data: Data, records: WorkRecord[]): LegacyCandidate[] {
  const rows: LegacyCandidate[] = data.notes.map((n) => {
    const body = n.title + '。' + n.content;
    const purchasing = /(购买|采购|订购|订货|下单|到货|催货|补货|订金|货款)/.test(body);
    const work =
      /(检查|检验|复核|漏水|质量|安装位置|协调|尺寸|设计调整|业主方案|师傅进场|协调安装)/.test(
        body,
      );
    const reference = /(参考资料|长期说明|说明书|色号|保养说明|联系人资料|资料存档)/.test(body);
    let kind: LegacyKind = 'pending',
      reason = '原始类别和内容不足以明确判断，请人工确认';
    if (n.kind === '材料采购') {
      kind = work ? 'pending' : 'purchase';
      reason = work ? '原采购类别与现场工作描述存在冲突' : '原始类别明确为材料采购';
    } else if (['施工安排', '业主确认', '现场复核'].includes(n.kind)) {
      kind = purchasing && !work ? 'pending' : 'record';
      reason =
        kind === 'pending'
          ? '原事项类别与购买描述存在冲突'
          : '原始结构化类别为施工、确认或复核事项';
    } else if (reference && !purchasing && !work) {
      kind = 'reference';
      reason = '参考资料或长期说明，不生成待办';
    } else if (work && !purchasing) {
      kind = 'record';
      reason = '存在明确的现场检查、协调或问题处理意图';
    } else if (purchasing && !work) {
      kind = 'purchase';
      reason = '存在购买、订货或到货跟进意图，不仅是材料名';
    }
    if (kind === 'purchase' && !noteDue(n)) {
      kind = 'pending';
      reason = '采购意图明确，但缺少计划日期，不能擅自补为今天';
    }
    if (kind === 'record' && n.owner.length > 100) {
      kind = 'pending';
      reason = '原负责人超过新事项字段上限，需要明确填写兼容负责人，原文仍保留';
    }
    return {
      key: legacyKey('note', n.projectId, n.id),
      sourceType: 'note',
      sourceId: n.id,
      projectId: n.projectId,
      title: n.title,
      content: n.content,
      date: noteDue(n),
      owner: n.owner,
      done: n.done,
      original: n,
      kind,
      reason,
      matches: [],
    };
  });
  for (const p of data.projects.filter((p) => p.notes.trim()))
    rows.push({
      key: legacyKey('project', p.id, p.id),
      sourceType: 'project',
      sourceId: p.id,
      projectId: p.id,
      title: p.name + ' · 项目说明',
      content: p.notes,
      date: '',
      owner: '',
      done: false,
      original: p,
      kind: /(购买|采购|订购|下单|到货)/.test(p.notes)
        ? 'pending'
        : /(检查|复核|处理漏水|协调安装|确认尺寸)/.test(p.notes)
          ? 'record'
          : /(参考资料|长期.{0,4}说明|说明书|保养说明|资料存档)/.test(p.notes)
            ? 'reference'
            : 'pending',
      reason: /(购买|采购|订购|下单|到货)/.test(p.notes)
        ? '项目说明含采购意图但无结构化计划日期，需要人工确认'
        : /(检查|复核|处理漏水|协调安装|确认尺寸)/.test(p.notes)
          ? '项目说明中有明确工作意图，保留原空日期'
          : /(参考资料|长期.{0,4}说明|说明书|保养说明|资料存档)/.test(p.notes)
            ? '项目长期说明保留为资料，不推断成采购或待办'
            : '项目说明语义不明确，保留原文并等待确认，不默认归档或生成事项',
      matches: [],
    });
  for (const row of rows) {
    if (
      rows.filter((other) => other.projectId === row.projectId && other.title === row.title)
        .length > 1
    ) {
      row.sourceDuplicates = true;
      row.kind = 'pending';
      row.reason = '同项目有多条同名历史来源，需要确认是否重复或明确为不同记录';
    }
    for (const p of data.purchases.filter(
      (p) => p.projectId === row.projectId && p.name === row.title,
    ))
      row.matches.push({
        kind: 'purchase',
        id: p.id,
        date: purchaseDue(p, data),
        owner: p.owner,
        content: p.notes,
        status: p.status,
        deleted: false,
        exact:
          purchaseDue(p, data) === row.date &&
          p.owner === row.owner &&
          p.notes === row.content &&
          (p.status === '已完成' || p.status === '已到货') === row.done,
      });
    for (const r of records.filter((r) => r.projectId === row.projectId && r.title === row.title))
      row.matches.push({
        kind: 'record',
        id: r.id,
        date: r.nodeDate,
        owner: r.owner || '',
        content: r.notes,
        status: r.status,
        deleted: !!r.deleted,
        exact:
          r.nodeDate === row.date &&
          (r.owner || '') === row.owner &&
          r.notes === row.content &&
          (r.status === '已完成') === row.done &&
          !r.deleted,
      });
    if (
      row.matches.length &&
      row.matches.filter((m) => m.exact && m.kind === row.kind).length !== 1
    ) {
      row.kind = 'pending';
      row.reason = '存在同项目同标题记录，需要核对是沿用现有记录还是明确新建，不能猜测重复关系';
    }
  }
  return rows;
}
export const sameLegacySource = (original: unknown, stored: unknown) =>
  canonical(original) === canonical(stored);

export function visibleLegacyNotes(notes: Note[], saved: Note[], links: LegacyLink[]) {
  return notes.filter(
    (n) =>
      !links.some(
        (l) =>
          l.sourceKey === legacyKey('note', n.projectId, n.id) &&
          l.matchesCurrent &&
          saved.some((old) => old.id === n.id && canonical(old) === canonical(n)),
      ),
  );
}
