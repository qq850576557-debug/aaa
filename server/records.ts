import type { Express } from 'express';
import type { AuthRequest } from './auth';
import { randomUUID } from 'node:crypto';
import { transaction } from './db';
import { ApiError, audit, getState, hash } from './store';
import { safeActorDisplayName } from './audit';
import {
  recordCreate,
  recordUpdate,
  recordDelete,
  recordFields,
  type WorkRecord,
} from '../src/lib/records';

const columns = `id,project_id AS "projectId",project_name AS "projectName",title,node_date AS "nodeDate",status,notes,follow_up AS "followUp",version,deleted,created_by AS "createdBy",created_name AS "createdName",created_at AS "createdAt",updated_by AS "updatedBy",updated_name AS "updatedName",updated_at AS "updatedAt"`;
const snapshot = (r: WorkRecord | null) =>
  r ? { projectId: r.projectId, status: r.status, nodeDate: r.nodeDate } : null;
export function recordRoutes(app: Express) {
  // These routes are registered AFTER the existing authentication and CSRF middleware.
  // Reuse workspace-wide business collaboration access; never grant account/material privileges.
  app.get('/api/records', async (req: AuthRequest, res, next) => {
    try {
      res.json({
        records: (
          await transaction((c) =>
            c.query(
              `SELECT ${columns} FROM work_record WHERE workspace_id=$1 AND NOT deleted ORDER BY updated_at DESC,id`,
              [req.actor!.workspaceId],
            ),
          )
        ).rows,
      });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/records/:id/history', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          const record = (
            await c.query(`SELECT ${columns} FROM work_record WHERE workspace_id=$1 AND id=$2`, [
              req.actor!.workspaceId,
              req.params.id,
            ])
          ).rows[0];
          if (!record) throw new ApiError(404, '记录不存在或无权访问');
          // No free-text snapshots: do not replicate phone numbers, credentials or personal notes into audit history.
          return {
            record,
            events: (
              await c.query(
                `SELECT id::text,actor_id AS "actorId",actor_name AS "actorName",at,operation,changed_fields AS "changedFields",before_value AS before,after_value AS after FROM record_history WHERE workspace_id=$1 AND record_id=$2 ORDER BY id DESC`,
                [req.actor!.workspaceId, req.params.id],
              )
            ).rows,
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  for (const method of ['post', 'put', 'delete'] as const) {
    app[method](
      method === 'post' ? '/api/records' : '/api/records/:id',
      async (req: AuthRequest, res, next) => {
        try {
          const body = (
              method === 'post' ? recordCreate : method === 'put' ? recordUpdate : recordDelete
            ).parse(req.body),
            a = req.actor!;
          const result = await transaction(async (c) => {
            // Same lock order as existing workspace saves: project removal and record creation cannot race.
            const state = await getState(c, a.workspaceId, 'UPDATE');
            const digest = hash(JSON.stringify({ method, id: req.params.id ?? null, body }));
            const submitted = (
              await c.query(
                'SELECT actor_id,body_hash,result FROM record_submission WHERE workspace_id=$1 AND request_id=$2',
                [a.workspaceId, body.requestId],
              )
            ).rows[0];
            if (submitted) {
              if (submitted.body_hash !== digest || submitted.actor_id !== a.id)
                throw new ApiError(409, '重复请求标识冲突');
              return submitted.result;
            }
            const old: WorkRecord | null =
              method === 'post'
                ? null
                : (
                    await c.query(
                      `SELECT ${columns} FROM work_record WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
                      [a.workspaceId, req.params.id],
                    )
                  ).rows[0];
            if (method !== 'post' && (!old || old.deleted))
              throw new ApiError(404, '记录已删除或不存在，请刷新看板');
            if (old && 'version' in body && old.version !== body.version)
              throw new ApiError(409, '记录已被其他人更新；草稿已保留，请重新读取后再保存');
            const value = 'value' in body ? body.value : old!;
            if (old && value.projectId !== old.projectId)
              throw new ApiError(400, '初版不支持跨项目移动记录');
            const project = state.data.projects.find((p) => p.id === value.projectId);
            if (!old && !project) throw new ApiError(400, '请选择当前工作空间的有效项目');
            const name = safeActorDisplayName(a.displayName ?? a.login),
              id = old?.id ?? randomUUID();
            const next = (
              await c.query(
                `INSERT INTO work_record(workspace_id,id,project_id,project_name,title,node_date,status,notes,follow_up,version,deleted,created_by,created_name,updated_by,updated_name)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,false,$10,$11,$10,$11)
            ON CONFLICT(workspace_id,id) DO UPDATE SET project_name=$4,title=$5,node_date=$6,status=$7,notes=$8,follow_up=$9,version=work_record.version+1,deleted=$12,updated_by=$10,updated_name=$11,updated_at=now() RETURNING ${columns}`,
                [
                  a.workspaceId,
                  id,
                  value.projectId,
                  project?.name ?? old!.projectName,
                  value.title,
                  value.nodeDate,
                  value.status,
                  value.notes,
                  value.followUp,
                  a.id,
                  name,
                  method === 'delete',
                ],
              )
            ).rows[0] as WorkRecord;
            const changedFields = Object.keys(recordFields).filter(
              (k) => (old as any)?.[k] !== (next as any)[k],
            );
            const operation =
              method === 'post' ? 'create' : method === 'delete' ? 'delete' : 'update';
            await c.query(
              'INSERT INTO record_history(workspace_id,record_id,actor_id,actor_name,operation,changed_fields,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                a.workspaceId,
                id,
                a.id,
                name,
                operation,
                JSON.stringify(changedFields),
                JSON.stringify(snapshot(old)),
                JSON.stringify(snapshot(next)),
              ],
            );
            await audit(c, a, `record.${operation}`, undefined, {
              entityType: 'record',
              entityId: id,
              operation,
              before: snapshot(old),
              after: snapshot(next),
              changedFields,
            });
            // Do not bump workspace revision: a board change cannot invalidate an unrelated Gantt draft.
            await c.query('INSERT INTO record_submission VALUES($1,$2,$3,$4,$5)', [
              a.workspaceId,
              body.requestId,
              a.id,
              digest,
              JSON.stringify(next),
            ]);
            return next;
          });
          res.json(result);
        } catch (e) {
          next(e);
        }
      },
    );
  }
}
