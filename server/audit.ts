import { createHmac } from 'node:crypto';
import type { Data } from '../src/lib/model';
import { canonical } from '../src/lib/history';

export type AuditDevice = {
  category: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  os: string;
  browser: string;
  model: string;
  source: 'User-Agent（未经硬件验证）';
};

/** Deliberately discard the raw UA; browser-provided device hints are not trusted identity. */
export function auditDevice(userAgent: string): AuditDevice {
  const ua = userAgent.slice(0, 1024);
  const iphone = /iPhone/i.test(ua),
    ipad = /iPad/i.test(ua) || /Macintosh.*Mobile\//i.test(ua);
  const android = /Android/i.test(ua);
  const mobile = iphone || /Mobile|Windows Phone/i.test(ua);
  const tablet = ipad || (android && !/Mobile/i.test(ua));
  const knownDesktop = /Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua);
  let model = iphone
    ? 'iPhone（具体型号不可识别）'
    : ipad
      ? 'iPad（具体型号不可识别）'
      : '具体型号不可识别';
  if (android) {
    // Many UAs omit/model-reduce this information. A recognizable Build segment is
    // reported only as an unverified UA hint, never as a hardware assertion.
    const hinted = ua
      .match(
        /Android[^;)]*;\s*(?:[a-z]{2}(?:[-_][a-z]{2})?;\s*)?([A-Za-z0-9][A-Za-z0-9 ._-]{1,39})\s+Build\//i,
      )?.[1]
      ?.trim();
    model =
      hinted &&
      !/\d{7,}/.test(hinted) &&
      /^(?:SM-[A-Z]\d{3,4}[A-Z0-9]{0,8}|Pixel \d{1,2}(?:a| Pro| Pro XL| XL| Fold)?)$/i.test(hinted)
        ? `${hinted}（浏览器报告，未验证）`
        : 'Android设备（具体型号不可识别）';
  }
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua)
    ? 'Edge'
    : /OPR\/|Opera\//i.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//i.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//i.test(ua)
          ? 'Chrome'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : '无法可靠识别';
  return {
    category: tablet ? 'tablet' : mobile ? 'mobile' : knownDesktop ? 'desktop' : 'unknown',
    os:
      iphone || ipad
        ? 'iOS / iPadOS'
        : android
          ? 'Android'
          : /Windows/i.test(ua)
            ? 'Windows'
            : /CrOS/i.test(ua)
              ? 'ChromeOS'
              : /Macintosh/i.test(ua)
                ? 'macOS'
                : /Linux|X11/i.test(ua)
                  ? 'Linux'
                  : '无法可靠识别',
    browser,
    model,
    source: 'User-Agent（未经硬件验证）',
  };
}

/** Formal names are public account labels, but redact obvious accidental secret/PII shapes. */
export function safeActorDisplayName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(
        /(?:Bearer\s+|(?:token|password|cookie|secret|key)\s*[:=]\s*)\S+/gi,
        '[已隐藏疑似凭据]',
      )
      .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[已隐藏疑似凭据]')
      .replace(/[A-Za-z0-9_=-]{32,}/g, '[已隐藏疑似凭据]')
      .replace(/\+?\d[\d ()-]*\d/g, (value) =>
        value.replace(/\D/g, '').length >= 9 ? '[已隐藏号码]' : value,
      )
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[已隐藏日期]')
      .trim()
      .slice(0, 80) || '未命名账号'
  );
}

const referenceDomains: Record<string, string> = {
  projectId: 'project',
  tradeId: 'trade',
  taskId: 'task',
  groupId: 'task-group',
  categoryId: 'dictionary',
  staffIds: 'person',
  tradeIds: 'dictionary',
  dependsOn: 'task',
};
function auditReference(domain: string, id: string, key: string) {
  return (
    'obj_' +
    createHmac('sha256', key)
      .update('chunmo-audit-reference-v1\0' + domain + '\0' + id)
      .digest('hex')
      .slice(0, 24)
  );
}

export type BusinessAuditChange = {
  entityType: 'project' | 'trade' | 'task' | 'purchase' | 'note' | 'person' | 'dictionary';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
};
const collections = [
  ['projects', 'project'],
  ['trades', 'trade'],
  ['tasks', 'task'],
  ['purchases', 'purchase'],
  ['notes', 'note'],
  ['people', 'person'],
  ['dictionaries', 'dictionary'],
] as const;
// Free text is recorded ONLY as changed field names. Do not persist names, owners,
// addresses, content, phone/birthdate, notes, approval reasons or request payloads.
const textFields = new Set([
  'name',
  'title',
  'label',
  'address',
  'owner',
  'manager',
  'notes',
  'content',
  'personnel',
  'quantity',
  'specification',
  'trade',
]);
const scalarFields = new Set([
  'projectId',
  'tradeId',
  'taskId',
  'groupId',
  'categoryId',
  'start',
  'end',
  'actualStart',
  'actualEnd',
  'date',
  'reminder',
  'due',
  'originalDue',
  'approvedDue',
  'updatedAt',
  'status',
  'role',
  'kind',
  'color',
  'defaultColor',
  'order',
  'leadDays',
  'active',
  'archived',
  'done',
  'pinned',
  'deleted',
  'deadlineMode',
]);
const arrayFields = new Set(['staffIds', 'tradeIds', 'dependsOn']);
const enumFields: Record<string, readonly string[]> = {
  status: [
    '施工中',
    '筹备中',
    '进行中',
    '已完工',
    '暂停',
    '未开始',
    '已完成',
    '已延期',
    '待采购',
    '已下单',
    '已到货',
  ],
  role: ['施工人员', '项目经理', '设计人员', '监理'],
  kind: [
    '施工安排',
    '材料采购',
    '业主确认',
    '现场复核',
    '到货验收',
    '其他事项',
    '项目备忘',
    'category',
    'trade',
  ],
  deadlineMode: ['fixed', 'linked'],
};
const boolFields = new Set(['active', 'archived', 'done', 'pinned', 'deleted']);
const dateFields = new Set([
  'start',
  'end',
  'actualStart',
  'actualEnd',
  'date',
  'reminder',
  'due',
  'originalDue',
  'approvedDue',
]);
const idOK = (value: unknown): value is string => typeof value === 'string' && value.length <= 100;
function scalar(key: string, value: unknown): string | boolean | number | undefined {
  if (enumFields[key])
    return typeof value === 'string' && enumFields[key].includes(value) ? value : undefined;
  if (boolFields.has(key)) return typeof value === 'boolean' ? value : undefined;
  if (key === 'order' || key === 'leadDays')
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  if (dateFields.has(key))
    return typeof value === 'string' && /^(?:\d{4}-\d{2}-\d{2})?$/.test(value) ? value : undefined;
  if (key === 'updatedAt')
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
      ? value
      : undefined;
  if (key === 'color' || key === 'defaultColor')
    return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : undefined;
  return idOK(value) ? value : undefined;
}
function safeSnapshot(
  record: Record<string, unknown>,
  referenceKey: string,
  position?: number,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of scalarFields) {
    const value = scalar(key, record[key]);
    if (value !== undefined)
      safe[key] =
        referenceDomains[key] && typeof value === 'string' && value
          ? auditReference(referenceDomains[key], value, referenceKey)
          : value;
  }
  for (const key of arrayFields) {
    const value = record[key];
    if (Array.isArray(value) && value.every(idOK))
      safe[key] = value
        .slice(0, 100)
        .map((id) => auditReference(referenceDomains[key], id, referenceKey));
  }
  if (Array.isArray(record.deadlineHistory))
    safe.deadlineHistory = record.deadlineHistory.slice(0, 1000).map((entry) => {
      const v = entry as Record<string, unknown>;
      return {
        from: scalar('due', v.from),
        to: scalar('due', v.to),
        at: scalar('updatedAt', v.at),
      };
    });
  if (position !== undefined) safe.position = position;
  return safe;
}

/** Input is already server-validated Data; these helpers still exclude all unknown properties. */
export function businessAuditChanges(
  before: Data,
  after: Data,
  referenceKey = 'isolated-audit-reference-test-key',
): BusinessAuditChange[] {
  // Production callers pass the protected deployment key. The default is solely
  // for isolated pure tests, never a replacement for production key management.
  if (referenceKey.length < 16) throw Error('Audit reference key must be supplied');
  const events: BusinessAuditChange[] = [];
  for (const [collection, entityType] of collections) {
    const old = (before[collection] ?? []) as { id: string }[],
      next = (after[collection] ?? []) as { id: string }[];
    const oldById = new Map(old.map((record, index) => [record.id, { record, index }]));
    const nextById = new Map(next.map((record, index) => [record.id, { record, index }]));
    for (const entityId of new Set([...oldById.keys(), ...nextById.keys()])) {
      const a = oldById.get(entityId),
        b = nextById.get(entityId);
      const aRecord = a?.record as Record<string, unknown> | undefined,
        bRecord = b?.record as Record<string, unknown> | undefined;
      const knownFields = new Set([
        ...scalarFields,
        ...arrayFields,
        ...textFields,
        'deadlineHistory',
      ]);
      const changedFields = [...knownFields].filter(
        (key) => canonical(aRecord?.[key]) !== canonical(bRecord?.[key]),
      );
      if (entityType === 'project' && a && b && a.index !== b.index) changedFields.push('position');
      if (a && b && !changedFields.length) continue;
      events.push({
        entityType,
        entityId: auditReference(entityType, entityId, referenceKey),
        operation: !a ? 'create' : !b ? 'delete' : 'update',
        before: aRecord
          ? safeSnapshot(aRecord, referenceKey, entityType === 'project' ? a!.index : undefined)
          : null,
        after: bRecord
          ? safeSnapshot(bRecord, referenceKey, entityType === 'project' ? b!.index : undefined)
          : null,
        changedFields,
      });
    }
  }
  return events;
}
