import { personProfile } from '../src/lib/person-identity';
import type { PoolClient } from 'pg';
import { trackPurchases } from './purchase-tracking';
import { syncMentions, validateMentionAccounts } from './mention-delivery';
import {
  businessAuditChanges,
  auditReference,
  safeActorDisplayName,
  type AuditDevice,
} from './audit';
type Db = Pick<PoolClient, 'query'>;
import { randomUUID, createHash } from 'node:crypto';
import {
  emptyData,
  parseBackup,
  prepareWorkspace,
  purchaseCeiling,
  purchaseDue,
  rawPurchaseDue,
  type Data,
} from '../src/lib/model';
import {
  emptyHistory,
  recordChanges,
  restoreBefore,
  retainHistory,
  validateHistory,
  mergeHistory,
  canonical,
  type History,
} from '../src/lib/history';
import { confirmPurchaseDeadline } from '../src/lib/procurement';
export class ApiError extends Error {
  validationIssues?: import('../src/lib/workspace-save-plan').ValidationIssue[];
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Actor = {
  id: string;
  workspaceId: string;
  login: string;
  owner: boolean;
  displayName?: string;
  avatarVersion?: string | null;
  cardAvatarVersion?: string | null;
  auditDevice?: AuditDevice;
};
// Reuse validation work only after reading and hashing the actual current DB row.
// Never cache authority or skip the live read/CAS. Clone on return so callers cannot
// mutate a shared baseline. Keep at most 8 MiB of serialized business snapshots.
const validatedReads = new Map<
  string,
  { fingerprint: string; data: Data; history: History; bytes: number }
>();
let validatedBytes = 0;
export async function getState(c: Db, workspaceId: string, lock = 'SHARE') {
  const q = await c.query(
    `SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1 FOR ${lock}`,
    [workspaceId],
  );
  if (!q.rowCount) throw new ApiError(404, '工作空间不存在');
  const row = q.rows[0];
  const serialized = JSON.stringify([row.data, row.history]);
  const fingerprint = hash(serialized);
  let cached = validatedReads.get(workspaceId);
  if (!cached || cached.fingerprint !== fingerprint) {
    const data = prepareWorkspace(parseBackup(row.data)),
      history = validateHistory(row.history);
    if (cached) {
      validatedBytes -= cached.bytes;
      validatedReads.delete(workspaceId);
    }
    cached = { fingerprint, data, history, bytes: Buffer.byteLength(serialized) };
    if (cached.bytes <= 8 * 1024 * 1024) {
      while (validatedBytes + cached.bytes > 8 * 1024 * 1024 || validatedReads.size >= 4) {
        const key = validatedReads.keys().next().value!;
        validatedBytes -= validatedReads.get(key)!.bytes;
        validatedReads.delete(key);
      }
      validatedReads.set(workspaceId, cached);
      validatedBytes += cached.bytes;
    }
  }
  return {
    revision: Number(row.revision),
    data: structuredClone(cached.data),
    history: retainHistory(structuredClone(cached.history)),
  };
}
export async function graph(c: Db, w: string, d: Data, prior: Data) {
  const tables = [
    ['project', d.projects, prior.projects, '', ''],
    ['person', d.people ?? [], prior.people ?? [], '', ''],
    ['trade', d.trades, prior.trades, ',project_id', ",v->>'projectId'"],
    [
      'task',
      d.tasks,
      prior.tasks,
      ',project_id,trade_id,start_date,end_date',
      ",v->>'projectId',v->>'tradeId',(v->>'start')::date,(v->>'end')::date",
    ],
    [
      'purchase',
      d.purchases,
      prior.purchases,
      ',project_id,task_id',
      ",v->>'projectId',NULLIF(v->>'taskId','')",
    ],
    [
      'memo',
      d.notes,
      prior.notes,
      ',project_id,task_id',
      ",v->>'projectId',NULLIF(v->>'taskId','')",
    ],
  ] as const;
  const scopes = [
    ['project', prior.projects, d.projects],
    ['trade', prior.trades, d.trades],
    ['task', prior.tasks, d.tasks],
  ] as const;
  for (const [kind, before, after] of scopes) {
    const old = new Map(before.map((x) => [x.id, x]));
    const next = new Map(after.map((x) => [x.id, x]));
    const ids = [...new Set([...old.keys(), ...next.keys()])].filter((id) => {
      const a = old.get(id),
        b = next.get(id);
      return (
        !a ||
        !b ||
        canonical([a.staffIds ?? [], (a as any).projectId ?? a.id]) !==
          canonical([b.staffIds ?? [], (b as any).projectId ?? b.id])
      );
    });
    if (!ids.length) continue;
    await c.query(
      'DELETE FROM assignment WHERE workspace_id=$1 AND scope_kind=$2 AND scope_id=ANY($3::text[])',
      [w, kind, ids],
    );
    const rows = after
      .filter((x) => ids.includes(x.id))
      .flatMap((x) =>
        (x.staffIds ?? []).map((person) => ({
          scope_kind: kind,
          scope_id: x.id,
          project_id: (x as any).projectId ?? x.id,
          person_id: person,
        })),
      );
    if (rows.length)
      await c.query(
        'INSERT INTO assignment SELECT $1,x.scope_kind,x.scope_id,x.project_id,x.person_id FROM jsonb_to_recordset($2::jsonb) AS x(scope_kind text,scope_id text,project_id text,person_id text)',
        [w, JSON.stringify(rows)],
      );
  }
  for (const [table, after, before] of [...tables].reverse()) {
    const ids = new Set(after.map((x) => x.id));
    const removed = before.filter((x) => !ids.has(x.id)).map((x) => x.id);
    if (removed.length)
      await c.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND id=ANY($2::text[])`, [
        w,
        removed,
      ]);
  }
  for (const [table, after, before, columns, expressions] of tables) {
    const old = new Map(before.map((x) => [x.id, x]));
    const changed = after.filter((x) => canonical(x) !== canonical(old.get(x.id)));
    if (!changed.length) continue;
    const updates = ['payload', ...columns.split(',').filter(Boolean)]
      .map((column) => `${column}=excluded.${column}`)
      .join(',');
    await c.query(
      `INSERT INTO ${table}(workspace_id,id,payload${columns}) SELECT $1,v->>'id',v${expressions} FROM jsonb_array_elements($2::jsonb) v ON CONFLICT(workspace_id,id) DO UPDATE SET ${updates}`,
      [w, JSON.stringify(changed)],
    );
  }
}
export async function audit(
  c: Db,
  a: Actor,
  action: string,
  revision?: number,
  detail?: {
    entityType: string;
    entityId: string;
    operation: string;
    before?: unknown;
    after?: unknown;
    changedFields?: string[];
  },
) {
  await c.query(
    `INSERT INTO audit_event(id,workspace_id,actor_id,action,revision,actor_display_name,entity_type,entity_id,operation,before_value,after_value,changed_fields,device)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      randomUUID(),
      a.workspaceId,
      a.id,
      action,
      revision ?? null,
      safeActorDisplayName(a.displayName ?? a.login),
      detail?.entityType ??
        (action.startsWith('account.')
          ? 'account'
          : action.startsWith('person.private')
            ? 'person_private'
            : 'workspace'),
      detail?.entityId ?? (action.startsWith('account.') ? a.id : a.workspaceId),
      detail?.operation ?? (action.endsWith('.create') ? 'create' : 'update'),
      detail?.before == null ? null : JSON.stringify(detail.before),
      detail?.after == null ? null : JSON.stringify(detail.after),
      JSON.stringify(detail?.changedFields ?? []),
      JSON.stringify(
        a.auditDevice ?? {
          category: 'unknown',
          os: '未知',
          browser: '未知',
          model: '未知设备',
          source: '未采集设备信息',
        },
      ),
    ],
  );
}
export async function commit(
  c: Db,
  a: Actor,
  base: number,
  input: Data,
  opts?: {
    prior?: Awaited<ReturnType<typeof getState>>;
    restoreId?: string;
    restoreAfter?: boolean;
    importHistory?: History;
    importing?: boolean;
    deadlineChange?: { id: string; date: string; reason: string };
  },
) {
  const prior = opts?.prior ?? (await getState(c, a.workspaceId, 'UPDATE'));
  if (prior.revision !== base)
    throw new ApiError(409, '版本冲突：他人已提交，请备份草稿并重新读取');
  if (!a.owner && prior.data.projects.some((p) => !input.projects.some((x) => x.id === p.id)))
    throw new ApiError(403, '删除项目仅限负责人');
  const restore = opts?.restoreId
    ? prior.history.records.find((r) => r.id === opts.restoreId)
    : undefined;
  if (opts?.restoreId && (!a.owner || !restore))
    throw new ApiError(a.owner ? 404 : 403, '无权恢复或版本不存在');
  let d: Data;
  if (opts?.restoreId) {
    try {
      d = restoreBefore(
        prior.data,
        opts.restoreAfter
          ? {
              ...prior.history,
              records: prior.history.records.map((r) =>
                r.id === opts.restoreId ? { ...r, before: r.after } : r,
              ),
            }
          : prior.history,
        opts.restoreId,
      );
    } catch {
      throw new ApiError(
        409,
        '该历史版本与现有人员、工序或任务关联不兼容；未恢复、未覆盖任何数据，请核对相关记录',
      );
    }
  } else d = prepareWorkspace(opts?.deadlineChange ? prior.data : input);
  if (opts?.deadlineChange) {
    if (!a.owner) throw new ApiError(403, '采购期限变更仅限负责人');
    const x = opts.deadlineChange;
    try {
      d = confirmPurchaseDeadline(prior.data, x.id, x.date, x.reason);
    } catch {
      throw new ApiError(400, '采购期限或变更原因无效');
    }
  } else if (!opts?.restoreId && !opts?.importing) {
    for (const p of d.purchases) {
      const old = prior.data.purchases.find((x) => x.id === p.id);
      if (old) {
        if (
          old.originalDue !== p.originalDue ||
          old.approvedDue !== p.approvedDue ||
          canonical(old.deadlineHistory ?? []) !== canonical(p.deadlineHistory ?? [])
        )
          throw new ApiError(403, '普通保存不得修改采购原定期限或审批历史');
        if (p.due !== old.due && p.due > purchaseCeiling(old, prior.data))
          throw new ApiError(403, '采购延期必须由负责人明确确认');
      } else {
        if (p.approvedDue || p.deadlineHistory?.length || p.originalDue !== rawPurchaseDue(p, d))
          throw new ApiError(400, '新采购的原定期限必须与实际计划一致，不能伪造审批');
      }
    }
  }
  const h = opts?.importHistory ? mergeHistory(prior.history, opts.importHistory) : prior.history;
  if (opts?.importing || opts?.restoreId)
    for (const p of d.purchases) {
      const before = prior.data.purchases.find((x) => x.id === p.id)?.mentionIds ?? [];
      await validateMentionAccounts(
        c,
        a,
        (p.mentionIds ?? []).filter((id) => !before.includes(id)),
        false,
      );
    }
  d = {
    ...d,
    purchases: d.purchases.map((p) => {
      const old = prior.data.purchases.find((x) => x.id === p.id);
      return p.mentionIds === undefined && old?.mentionIds
        ? { ...p, mentionIds: old.mentionIds }
        : p;
    }),
  };
  const result = recordChanges(
    prior.data,
    d,
    h,
    Date.now(),
    restore ? { scope: restore.scope, source: restore.id } : undefined,
  );
  const previousIds = new Set(prior.history.records.map((r) => r.id));
  result.history.records = result.history.records.map((r) =>
    !previousIds.has(r.id) && !opts?.importHistory?.records.some((x) => x.id === r.id)
      ? { ...r, actor: a.displayName ?? a.login, actorId: a.id }
      : r,
  );
  const revision = prior.revision + 1;
  for (const r of result.history.records.filter(
    (r) =>
      !previousIds.has(r.id) &&
      !opts?.importHistory?.records.some((imported) => imported.id === r.id),
  ))
    await c.query(
      'INSERT INTO workspace_history_revision VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.workspaceId, r.id, revision],
    );
  await trackPurchases(c, a, prior.data, result.data, !!(opts?.importing || opts?.restoreId));
  if (!opts?.importing && !opts?.restoreId)
    for (const [index, p] of result.data.purchases.entries()) {
      const old = prior.data.purchases.find((x) => x.id === p.id);
      const project = result.data.projects.find((x) => x.id === p.projectId)!;
      try {
        await syncMentions(
          c,
          a,
          'purchase',
          p.id,
          old?.mentionIds ?? [],
          p.mentionIds ?? [],
          project,
          purchaseDue(p, result.data),
          p.name,
          p.notes,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 400)
          e.validationIssues = [
            {
              path: ['data', 'purchases', index, 'mentionIds'],
              resource: { collection: 'purchases', id: p.id },
              code: 'custom',
              message: e.message,
            },
          ];
        throw e;
      }
    }
  if (!opts?.restoreId) {
    const priorIds = new Set((prior.data.people ?? []).map((p) => p.id));
    const profiles = new Map<string, NonNullable<Data['people']>>();
    for (const person of result.data.people ?? []) {
      const fingerprint = personProfile(person);
      const rows = profiles.get(fingerprint) ?? [];
      rows.push(person);
      profiles.set(fingerprint, rows);
    }
    for (const person of result.data.people ?? []) {
      if (priorIds.has(person.id)) continue; // Existing same-name records are retained verbatim.
      const duplicate = profiles.get(personProfile(person))?.find((x) => x.id !== person.id);
      if (duplicate) {
        const error = new ApiError(
          400,
          duplicate.deleted
            ? '相同资料的人员档案已删除，不能作为新档案自动重新创建；请核对历史，或为确属不同的人员补充区分信息。'
            : '已有相同姓名和资料的人员档案，未重复创建；请使用原档案，确属不同人员时请补充区分信息。',
        );
        error.validationIssues = [
          {
            path: ['data', 'people'],
            code: 'custom',
            message: error.message,
            resource: { collection: 'people', id: person.id },
          },
        ];
        throw error;
      }
    }
  }
  // Ordinary saves/imports must never act as an implicit restore. Audit history is
  // append-only and outlives the UI history retention; no new table or data migration.
  if (!opts?.restoreId) {
    const key = process.env.PRIVATE_DATA_KEY;
    if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new ApiError(500, '删除保护校验配置无效');
    const collections = [
      ['projects', 'project'],
      ['trades', 'trade'],
      ['tasks', 'task'],
      ['notes', 'note'],
      ['purchases', 'purchase'],
      ['people', 'person'],
      ['dictionaries', 'dictionary'],
    ] as const;
    const additions = collections.flatMap(([collection, type]) => {
      const old = new Set((prior.data[collection] ?? []).map((x) => x.id));
      return (result.data[collection] ?? [])
        .filter((x) => !old.has(x.id))
        .map((x) => ({ collection, type, id: x.id, reference: auditReference(type, x.id, key) }));
    });
    const priorDeleted = additions.length
      ? await c.query(
          "SELECT DISTINCT entity_type,entity_id FROM audit_event WHERE workspace_id=$1 AND action='business.delete' AND entity_id=ANY($2::text[])",
          [a.workspaceId, additions.flatMap((x) => [x.reference, x.id])],
        )
      : { rows: [] };
    const blocked = additions.filter((x) =>
      priorDeleted.rows.some(
        (row) => row.entity_type === x.type && [x.reference, x.id].includes(row.entity_id),
      ),
    );
    for (const person of result.data.people ?? []) {
      const old = prior.data.people?.find((x) => x.id === person.id);
      if (old?.deleted && !person.deleted)
        blocked.push({ collection: 'people', type: 'person', id: person.id, reference: '' });
    }
    if (blocked.length) {
      const error = new ApiError(
        400,
        '已删除的记录不能通过旧草稿、普通保存或备份导入重新出现；原始内容已保留，请通过历史恢复明确处理。',
      );
      error.validationIssues = blocked.map((x) => ({
        path: ['data', x.collection],
        code: 'custom',
        message: '该记录已删除，禁止隐式恢复',
        resource: { collection: x.collection, id: x.id },
      }));
      throw error;
    }
  }
  await graph(c, a.workspaceId, result.data, prior.data);
  await c.query('UPDATE workspace_state SET revision=$2,data=$3,history=$4 WHERE workspace_id=$1', [
    a.workspaceId,
    revision,
    JSON.stringify(result.data),
    JSON.stringify(result.history),
  ]);
  const auditKey = process.env.PRIVATE_DATA_KEY;
  if (!auditKey || !/^[a-f0-9]{64}$/i.test(auditKey))
    throw new ApiError(500, '审计配置无效，未保存修改');
  for (const change of businessAuditChanges(prior.data, result.data, auditKey))
    await audit(c, a, 'business.' + change.operation, revision, change);
  await audit(
    c,
    a,
    opts?.restoreId
      ? 'version.restore'
      : opts?.importing
        ? 'workspace.import'
        : opts?.deadlineChange
          ? 'purchase.deadline.change'
          : 'workspace.save',
    revision,
  );
  await c.query("SELECT pg_notify('chunmo_updates',$1)", [
    JSON.stringify({ workspaceId: a.workspaceId, revision }),
  ]);
  return { ...result, revision };
}
export function mergeImport(base: Data, incoming: Data): Data {
  const merged = { ...base };
  for (const key of [
    'projects',
    'trades',
    'tasks',
    'notes',
    'purchases',
    'people',
    'dictionaries',
  ] as const) {
    const old = base[key] ?? [],
      next = incoming[key] ?? [];
    const map = new Map<string, unknown>(old.map((x) => [x.id, x]));
    for (const x of next) {
      if (map.has(x.id) && canonical(map.get(x.id)) !== canonical(x))
        throw new ApiError(409, '备份存在同ID不同内容，未覆盖云端记录');
      map.set(x.id, x);
    }
    if (base[key] !== undefined || incoming[key] !== undefined)
      Object.assign(merged, { [key]: [...map.values()] });
  }
  merged.recentColors = [...new Set([...base.recentColors, ...incoming.recentColors])].slice(0, 12);
  if (base.nameHistory || incoming.nameHistory)
    merged.nameHistory = [
      ...new Set([...(base.nameHistory ?? []), ...(incoming.nameHistory ?? [])]),
    ].slice(-2000);
  return parseBackup(merged);
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function createWorkspace(
  c: Db,
  login: string,
  passwordHash: string,
  workspaceName: string,
) {
  const workspaceId = randomUUID(),
    id = randomUUID();
  await c.query('INSERT INTO cloud_workspace VALUES($1,$2,$3)', [workspaceId, workspaceName, id]);
  await c.query(
    "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES($1,$2,$3,$4,'owner')",
    [id, workspaceId, login, passwordHash],
  );
  await c.query('INSERT INTO workspace_state VALUES($1,0,$2,$3)', [
    workspaceId,
    JSON.stringify(emptyData()),
    JSON.stringify(emptyHistory()),
  ]);
  return { workspaceId, id };
}
