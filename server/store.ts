import type { PoolClient } from 'pg';
type Db = Pick<PoolClient, 'query'>;
import { randomUUID, createHash } from 'node:crypto';
import {
  emptyData,
  parseBackup,
  prepareWorkspace,
  purchaseCeiling,
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
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Actor = { id: string; workspaceId: string; login: string; owner: boolean };
export async function getState(c: Db, workspaceId: string, lock = 'SHARE') {
  const q = await c.query(
    `SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1 FOR ${lock}`,
    [workspaceId],
  );
  if (!q.rowCount) throw new ApiError(404, '工作空间不存在');
  const row = q.rows[0];
  return {
    revision: Number(row.revision),
    data: prepareWorkspace(parseBackup(row.data)),
    history: retainHistory(validateHistory(row.history)),
  };
}
export async function graph(c: Db, w: string, d: Data) {
  for (const table of ['assignment', 'memo', 'purchase', 'task', 'trade', 'project', 'person'])
    await c.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [w]);
  const insert = async (table: string, list: unknown[], columns: string, expressions: string) => {
    await c.query(
      `INSERT INTO ${table}(workspace_id,id,payload${columns}) SELECT $1,v->>'id',v${expressions} FROM jsonb_array_elements($2::jsonb) v`,
      [w, JSON.stringify(list)],
    );
  };
  await insert('project', d.projects, '', '');
  await insert('person', d.people ?? [], '', '');
  await insert('trade', d.trades, ',project_id', ",v->>'projectId'");
  await insert(
    'task',
    d.tasks,
    ',project_id,trade_id,start_date,end_date',
    ",v->>'projectId',v->>'tradeId',(v->>'start')::date,(v->>'end')::date",
  );
  for (const [table, list] of [
    ['purchase', d.purchases],
    ['memo', d.notes],
  ] as const)
    await insert(table, list, ',project_id,task_id', ",v->>'projectId',NULLIF(v->>'taskId','')");
  const assignments = [
    ...d.projects.flatMap((x) =>
      (x.staffIds ?? []).map((person) => ({
        scope_kind: 'project',
        scope_id: x.id,
        project_id: x.id,
        person_id: person,
      })),
    ),
    ...d.trades.flatMap((x) =>
      (x.staffIds ?? []).map((person) => ({
        scope_kind: 'trade',
        scope_id: x.id,
        project_id: x.projectId,
        person_id: person,
      })),
    ),
    ...d.tasks.flatMap((x) =>
      (x.staffIds ?? []).map((person) => ({
        scope_kind: 'task',
        scope_id: x.id,
        project_id: x.projectId,
        person_id: person,
      })),
    ),
  ];
  await c.query(
    'INSERT INTO assignment SELECT $1,x.scope_kind,x.scope_id,x.project_id,x.person_id FROM jsonb_to_recordset($2::jsonb) AS x(scope_kind text,scope_id text,project_id text,person_id text)',
    [w, JSON.stringify(assignments)],
  );
}
export async function audit(c: Db, a: Actor, action: string, revision?: number) {
  await c.query(
    'INSERT INTO audit_event(id,workspace_id,actor_id,action,revision) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), a.workspaceId, a.id, action, revision ?? null],
  );
}
export async function commit(
  c: Db,
  a: Actor,
  base: number,
  input: Data,
  opts?: {
    restoreId?: string;
    importHistory?: History;
    importing?: boolean;
    deadlineChange?: { id: string; date: string; reason: string };
  },
) {
  const prior = await getState(c, a.workspaceId, 'UPDATE');
  if (prior.revision !== base)
    throw new ApiError(409, '版本冲突：他人已提交，请备份草稿并重新读取');
  if (!a.owner && prior.data.projects.some((p) => !input.projects.some((x) => x.id === p.id)))
    throw new ApiError(403, '删除项目仅限负责人');
  const restore = opts?.restoreId
    ? prior.history.records.find((r) => r.id === opts.restoreId)
    : undefined;
  if (opts?.restoreId && (!a.owner || !restore))
    throw new ApiError(a.owner ? 404 : 403, '无权恢复或版本不存在');
  let d = opts?.restoreId
    ? restoreBefore(prior.data, prior.history, opts.restoreId)
    : prepareWorkspace(opts?.deadlineChange ? prior.data : input);
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
          old.projectId !== p.projectId ||
          old.originalDue !== p.originalDue ||
          old.approvedDue !== p.approvedDue ||
          canonical(old.deadlineHistory ?? []) !== canonical(p.deadlineHistory ?? [])
        )
          throw new ApiError(403, '普通保存不得修改采购原定期限、审批历史或所属项目');
        if (p.due !== old.due && p.due > purchaseCeiling(old, prior.data))
          throw new ApiError(403, '采购延期必须由负责人明确确认');
      } else {
        if (p.approvedDue || p.deadlineHistory?.length || p.originalDue !== rawPurchaseDue(p, d))
          throw new ApiError(400, '新采购的原定期限必须与实际计划一致，不能伪造审批');
      }
    }
  }
  const h = opts?.importHistory ? mergeHistory(prior.history, opts.importHistory) : prior.history;
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
      ? { ...r, actor: a.login, actorId: a.id }
      : r,
  );
  const revision = prior.revision + 1;
  await graph(c, a.workspaceId, result.data);
  await c.query('UPDATE workspace_state SET revision=$2,data=$3,history=$4 WHERE workspace_id=$1', [
    a.workspaceId,
    revision,
    JSON.stringify(result.data),
    JSON.stringify(result.history),
  ]);
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
