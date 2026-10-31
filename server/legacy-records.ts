import type { Express } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './auth';
import { owner } from './auth';
import { transaction } from './db';
import { ApiError, getState, commit, hash, audit } from './store';
import { canonical, validateHistory } from '../src/lib/history';
import { legacyCandidates } from '../src/lib/legacy-records';
import { prepareWorkspace, parseBackup, dateOK } from '../src/lib/model';
import { recordValue, type WorkRecord } from '../src/lib/records';
import type { PoolClient } from 'pg';
const linksSQL = `SELECT source_key AS "sourceKey",source_id AS "sourceId",project_id AS "projectId",source_hash AS "sourceHash",target_kind AS "targetKind",target_id AS "targetId",source,source_history AS history,at FROM legacy_record_link WHERE workspace_id=$1`;
const selection = z
  .object({
    key: z.string().max(400),
    hash: z.string().length(64),
    kind: z.enum(['purchase', 'record', 'reference']),
    date: z
      .string()
      .refine((v) => !v || dateOK(v))
      .optional(),
    owner: z.string().max(4000).optional(),
    existingId: z.string().max(100).optional(),
    confirmNew: z.boolean().optional(),
  })
  .strict();
const input = z
  .object({
    requestId: z.uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/i),
    expires: z.number().int(),
    confirmed: z.literal(true),
    backupConfirmed: z.literal(true),
    selections: z.array(selection).min(1).max(500),
  })
  .strict();
function sign(value: unknown) {
  const key = process.env.PRIVATE_DATA_KEY;
  if (!key) throw new ApiError(500, '迁移校验配置缺失');
  return createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(value)).digest('hex');
}
async function preview(
  c: PoolClient,
  workspaceId: string,
  actorId: string,
  lock = 'SHARE',
  expires = Date.now() + 600000,
) {
  const state = await getState(c, workspaceId, lock);
  const records = (
    await c.query(
      `SELECT id,project_id AS "projectId",title,node_date AS "nodeDate",status,notes,follow_up AS "followUp",owner,deleted,version FROM work_record WHERE workspace_id=$1 ORDER BY id`,
      [workspaceId],
    )
  ).rows as WorkRecord[];
  const links = (await c.query(linksSQL, [workspaceId])).rows;
  const rows = legacyCandidates(state.data, records).map((row) => {
    const sourceHash = hash(
      canonical(
        row.sourceType === 'project' ? { id: row.sourceId, notes: row.content } : row.original,
      ),
    );
    const link = links.find((x) => x.sourceKey === row.key);
    return {
      ...row,
      hash: sourceHash,
      link,
      sourceChanged: !!link && link.sourceHash !== sourceHash,
    };
  });
  const token = sign({
    workspaceId,
    actorId,
    expires,
    revision: state.revision,
    data: state.data,
    records,
    links,
  });
  return { state, records, links, rows, token, expires };
}
async function backup(c: PoolClient, p: Awaited<ReturnType<typeof preview>>, w: string) {
  // getState applies the UI retention window and normalizes defaults. Archive the actual
  // stored payload before any write, including older history still present in the database.
  const raw = (
    await c.query('SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1', [w])
  ).rows[0];
  return {
    format: 'chunmo-legacy-migration-backup',
    version: 1,
    workspaceId: w,
    revision: Number(raw.revision),
    exportedAt: new Date().toISOString(),
    data: raw.data,
    history: raw.history,
    records: (await c.query('SELECT * FROM work_record WHERE workspace_id=$1', [w])).rows,
    recordSubmissions: (await c.query('SELECT * FROM record_submission WHERE workspace_id=$1', [w]))
      .rows,
    purchaseRecords: (await c.query('SELECT * FROM purchase_record WHERE workspace_id=$1', [w]))
      .rows,
    purchaseHistory: (await c.query('SELECT * FROM purchase_action WHERE workspace_id=$1', [w]))
      .rows,
    recordHistory: (
      await c.query('SELECT * FROM record_history WHERE workspace_id=$1 ORDER BY id', [w])
    ).rows,
    recordLinks: p.links,
  };
}
export function legacyRoutes(app: Express) {
  app.get('/api/legacy-migration/preview', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          const p = await preview(c, req.actor!.workspaceId, req.actor!.id);
          return {
            rows: p.rows,
            token: p.token,
            expires: p.expires,
            revision: p.state.revision,
            projects: p.state.data.projects.map((project) => ({
              id: project.id,
              name: project.name,
              existingPurchases: p.state.data.purchases.filter((x) => x.projectId === project.id)
                .length,
              existingRecords: p.records.filter((x) => x.projectId === project.id && !x.deleted)
                .length,
              counts: Object.fromEntries(
                ['purchase', 'record', 'reference', 'pending'].map((kind) => [
                  kind,
                  p.rows.filter(
                    (x) =>
                      x.projectId === project.id &&
                      ((kind === 'pending' && x.sourceChanged) || (!x.link && x.kind === kind)),
                  ).length,
                ]),
              ),
            })),
            historyVersions: p.state.history.records.length,
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/legacy-migration/backup', owner, async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          const raw = await c.query(
            'SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1 FOR SHARE',
            [req.actor!.workspaceId],
          );
          if (!raw.rowCount) throw new ApiError(404, '工作空间不存在');
          const p = {
            state: raw.rows[0],
            links: (await c.query(linksSQL, [req.actor!.workspaceId])).rows,
          } as Awaited<ReturnType<typeof preview>>;
          return backup(c, p, req.actor!.workspaceId);
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/legacy-migration/backup/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      const result = await transaction((c) =>
        c.query(
          'SELECT backup FROM legacy_migration_batch WHERE workspace_id=$1 AND request_id=$2',
          [req.actor!.workspaceId, req.params.id],
        ),
      );
      if (!result.rowCount) throw new ApiError(404, '迁移备份不存在');
      res.json(result.rows[0].backup);
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/legacy-migration/source/:kind/:id', async (req: AuthRequest, res, next) => {
    try {
      const result = await transaction((c) =>
        c.query(linksSQL + ' AND target_kind=$2 AND target_id=$3', [
          req.actor!.workspaceId,
          req.params.kind,
          req.params.id,
        ]),
      );
      res.json({ sources: result.rows });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/legacy-migration/commit', owner, async (req: AuthRequest, res, next) => {
    try {
      const body = input.parse(req.body),
        a = req.actor!,
        digest = hash(canonical(body));
      res.json(
        await transaction(async (c) => {
          const prior = await c.query(
            'SELECT actor_id,body_hash,result FROM legacy_migration_batch WHERE workspace_id=$1 AND request_id=$2',
            [a.workspaceId, body.requestId],
          );
          if (prior.rowCount) {
            if (prior.rows[0].actor_id !== a.id || prior.rows[0].body_hash !== digest)
              throw new ApiError(409, '迁移请求编号对应不同内容');
            return prior.rows[0].result;
          }
          const p = await preview(c, a.workspaceId, a.id, 'UPDATE', body.expires);
          // Check again under the same lock for simultaneous duplicate submissions.
          const repeated = await c.query(
            'SELECT actor_id,body_hash,result FROM legacy_migration_batch WHERE workspace_id=$1 AND request_id=$2',
            [a.workspaceId, body.requestId],
          );
          if (repeated.rowCount) {
            if (repeated.rows[0].actor_id !== a.id || repeated.rows[0].body_hash !== digest)
              throw new ApiError(409, '迁移请求编号冲突');
            return repeated.rows[0].result;
          }
          if (
            body.expires < Date.now() ||
            body.expires > Date.now() + 601000 ||
            !timingSafeEqual(Buffer.from(body.token, 'hex'), Buffer.from(p.token, 'hex'))
          )
            throw new ApiError(409, '来源或目标已变化，请重新预览；未迁移数据');
          if (new Set(body.selections.map((x) => x.key)).size !== body.selections.length)
            throw new ApiError(400, '重复来源选择');
          const savedBackup = await backup(c, p, a.workspaceId);
          const sourceHistory = validateHistory(savedBackup.history);
          const next = structuredClone(p.state.data);
          const results: { key: string; kind: string; id: string | null; reused: boolean }[] = [];
          for (const decision of body.selections) {
            const row = p.rows.find((x) => x.key === decision.key);
            if (!row || row.hash !== decision.hash)
              throw new ApiError(409, '原始记录已变化，未迁移');
            if (row.link) {
              if (row.sourceChanged)
                throw new ApiError(409, '已迁移来源又有修改，请人工核对，未覆盖目标');
              results.push({
                key: row.key,
                kind: row.link.targetKind,
                id: row.link.targetId,
                reused: true,
              });
              continue;
            }
            if (!next.projects.some((x) => x.id === row.projectId))
              throw new ApiError(400, '来源项目不存在');
            const date = decision.date ?? row.date,
              assigned = decision.owner ?? row.owner;
            const exact = row.matches.filter((m) => m.exact && m.kind === decision.kind);
            let targetId: string | null = null;
            let reused = false;
            if (decision.kind !== 'reference') {
              const candidate = decision.existingId
                ? row.matches.find((m) => m.id === decision.existingId && m.kind === decision.kind)
                : exact.length === 1
                  ? exact[0]
                  : undefined;
              if (decision.existingId && !candidate)
                throw new ApiError(400, '沿用目标必须属于同项目同类别候选');
              if (candidate) {
                if (candidate.deleted)
                  throw new ApiError(409, '目标已经删除，不能沿用；请核对是否需要明确新建');
                targetId = candidate.id;
                reused = true;
              } else {
                if ((row.matches.length || row.sourceDuplicates) && !decision.confirmNew)
                  throw new ApiError(409, '可能重复，请明确选择沿用或确认新建');
                targetId =
                  'legacy-' +
                  decision.kind +
                  '-' +
                  hash(canonical([a.workspaceId, row.key])).slice(0, 48);
                if (decision.kind === 'purchase') {
                  if (!date || !dateOK(date))
                    throw new ApiError(400, '请明确填写采购计划日期，不能猜测');
                  if (next.purchases.some((x) => x.id === targetId))
                    throw new ApiError(409, '稳定目标编号已存在，请核对');
                  next.purchases.push({
                    id: targetId,
                    projectId: row.projectId,
                    name: row.title,
                    taskId:
                      row.sourceType === 'note'
                        ? ((row.original as { taskId?: string }).taskId ?? '')
                        : '',
                    due: date,
                    originalDue: date,
                    deadlineMode: 'fixed',
                    leadDays: 0,
                    status: row.done ? '已完成' : '待采购',
                    owner: assigned,
                    notes: row.content,
                  });
                } else {
                  const value = recordValue.parse({
                    projectId: row.projectId,
                    title: row.title,
                    nodeDate: date,
                    status: row.done ? '已完成' : '待执行',
                    notes: row.content,
                    followUp:
                      row.sourceType === 'note' && (row.original as { reminder?: string }).reminder
                        ? `原提醒日期：${(row.original as { reminder: string }).reminder}`
                        : '',
                    owner: assigned,
                  });
                  const project = next.projects.find((x) => x.id === row.projectId)!;
                  const name = a.displayName ?? a.login;
                  await c.query(
                    `INSERT INTO work_record(workspace_id,id,project_id,project_name,title,node_date,status,notes,follow_up,owner,version,created_by,created_name,updated_by,updated_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$11,$12)`,
                    [
                      a.workspaceId,
                      targetId,
                      row.projectId,
                      project.name,
                      value.title,
                      value.nodeDate,
                      value.status,
                      value.notes,
                      value.followUp,
                      value.owner,
                      a.id,
                      name,
                    ],
                  );
                  await c.query(
                    `INSERT INTO record_history(workspace_id,record_id,actor_id,actor_name,operation,changed_fields,before_value,after_value) VALUES($1,$2,$3,$4,'create',$5,null,$6)`,
                    [
                      a.workspaceId,
                      targetId,
                      a.id,
                      name,
                      JSON.stringify(['title', 'nodeDate', 'status', 'owner']),
                      JSON.stringify({
                        projectId: row.projectId,
                        status: value.status,
                        nodeDate: value.nodeDate,
                      }),
                    ],
                  );
                }
              }
            }
            const sourceAt = (key: string) => {
              const snap = sourceHistory.snapshots[key];
              if (snap?.kind !== 'project') return undefined;
              return row.sourceType === 'note'
                ? snap.data.notes.find((n) => n.id === row.sourceId)
                : snap.data.projects.find((project) => project.id === row.projectId)?.notes;
            };
            const history = sourceHistory.records.filter(
              (r) =>
                r.scope === row.projectId &&
                canonical(sourceAt(r.before)) !== canonical(sourceAt(r.after)),
            );
            await c.query(
              'INSERT INTO legacy_record_link(workspace_id,source_key,source_id,project_id,source_hash,source,source_history,target_kind,target_id,actor_id,batch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
              [
                a.workspaceId,
                row.key,
                row.sourceId,
                row.projectId,
                row.hash,
                JSON.stringify(row.original),
                JSON.stringify({
                  revisions: history,
                  snapshotRefs: [...new Set(history.flatMap((r) => [r.before, r.after]))],
                }),
                decision.kind,
                targetId,
                a.id,
                body.requestId,
              ],
            );
            results.push({ key: row.key, kind: decision.kind, id: targetId, reused });
          }
          if (canonical(next) !== canonical(p.state.data))
            await commit(c, a, p.state.revision, prepareWorkspace(parseBackup(next)));
          const result = { requestId: body.requestId, results, backupId: body.requestId };
          await c.query(
            'INSERT INTO legacy_migration_batch(workspace_id,request_id,actor_id,body_hash,backup,result) VALUES($1,$2,$3,$4,$5,$6)',
            [
              a.workspaceId,
              body.requestId,
              a.id,
              digest,
              JSON.stringify(savedBackup),
              JSON.stringify(result),
            ],
          );
          await audit(c, a, 'legacy.migrate', undefined, {
            entityType: 'legacy_migration',
            entityId: body.requestId,
            operation: 'migrate',
            changedFields: [],
            after: { count: results.length },
          });
          return result;
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
