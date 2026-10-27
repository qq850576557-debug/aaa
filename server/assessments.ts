import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit, hash, type Actor } from './store';
import {
  assessmentEdit,
  assessmentCandidates,
  assessmentCSV,
  daySchema,
  keyOf,
  type Assessment,
} from '../src/lib/assessments';
import { parseBackup, today } from '../src/lib/model';
async function allowed(c: PoolClient, a: Actor, write = false) {
  // Serializes writes and grant revocation; reads hold a shared authorization lock.
  await c.query(
    `SELECT workspace_id FROM workspace_state WHERE workspace_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
    [a.workspaceId],
  );
  const grant = await c.query(
    'SELECT 1 FROM assessment_recorder WHERE workspace_id=$1 AND account_id=$2',
    [a.workspaceId, a.id],
  );
  if (!a.owner && !grant.rowCount) throw new ApiError(403, '仅负责人或获授权的考核记录人可操作');
}
const querySchema = z
  .object({
    from: daySchema.optional(),
    to: daySchema.optional(),
    personId: z.string().max(100).optional(),
    projectId: z.string().max(100).optional(),
    tradeId: z.string().max(100).optional(),
    field: z.enum(['attendance', 'photo', 'cleaning']).optional(),
    status: z.enum(['pending', 'yes', 'no']).optional(),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export function assessmentRoutes(app: Express) {
  app.get('/api/assessments/access', async (req: AuthRequest, res, next) => {
    try {
      const value = await transaction(async (c) => {
        await c.query('SELECT workspace_id FROM workspace_state WHERE workspace_id=$1 FOR SHARE', [
          req.actor!.workspaceId,
        ]);
        const q = await c.query(
          'SELECT account_id FROM assessment_recorder WHERE workspace_id=$1',
          [req.actor!.workspaceId],
        );
        return {
          allowed: req.actor!.owner || q.rows.some((r) => r.account_id === req.actor!.id),
          owner: req.actor!.owner,
          ...(req.actor!.owner ? { recorders: q.rows.map((r) => r.account_id) } : {}),
        };
      });
      res.json(value);
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/assessments/recorders/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      await transaction(async (c) => {
        await c.query('SELECT workspace_id FROM workspace_state WHERE workspace_id=$1 FOR UPDATE', [
          req.actor!.workspaceId,
        ]);
        const q = await c.query(
          'SELECT id FROM account WHERE workspace_id=$1 AND id=$2 AND active=true',
          [req.actor!.workspaceId, req.params.id],
        );
        if (!q.rowCount) throw new ApiError(404, '账号不存在或已停用');
        if (body.enabled)
          await c.query(
            'INSERT INTO assessment_recorder(workspace_id,account_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [req.actor!.workspaceId, req.params.id, req.actor!.id],
          );
        else
          await c.query('DELETE FROM assessment_recorder WHERE workspace_id=$1 AND account_id=$2', [
            req.actor!.workspaceId,
            req.params.id,
          ]);
        await audit(c, req.actor!, 'assessment.grant', undefined, {
          entityType: 'account',
          entityId: String(req.params.id),
          operation: 'update',
          changedFields: ['assessmentRecorder'],
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  for (const exporting of [false, true])
    app.get(
      '/api/assessments' + (exporting ? '/export' : ''),
      async (req: AuthRequest, res, next) => {
        try {
          const q = querySchema.parse(req.query),
            from = q.from ?? today(),
            to = q.to ?? from;
          if (from > to) throw new ApiError(400, '日期范围无效');
          const rows = await transaction(async (c) => {
            await allowed(c, req.actor!);
            const args: unknown[] = [req.actor!.workspaceId, from, to];
            const terms = ['workspace_id=$1', 'work_date BETWEEN $2 AND $3'];
            for (const [key, column] of [
              ['personId', 'person_id'],
              ['projectId', 'project_id'],
              ['tradeId', 'trade_id'],
            ] as const)
              if (q[key]) {
                args.push(q[key]);
                terms.push(column + '=$' + args.length);
              }
            if (q.status) {
              if (!q.field) throw new ApiError(400, '请选择考核项目');
              args.push(q.field, q.status);
              terms.push(`payload->>$${args.length - 1}=$${args.length}`);
            }
            if (q.cursor) {
              args.push(q.cursor);
              terms.push('id>$' + args.length);
            }
            return (
              await c.query(
                `SELECT payload FROM daily_assessment WHERE ${terms.join(' AND ')} ORDER BY id LIMIT ${exporting ? 50001 : 1001}`,
                args,
              )
            ).rows.map((r) => r.payload as Assessment);
          });
          if (exporting) {
            if (rows.length > 50000)
              throw new ApiError(400, '导出范围超过50000条，请按年份、项目或师傅分批导出');
            res
              .type('text/csv; charset=utf-8')
              .attachment('chunmo-assessments.csv')
              .send(assessmentCSV(rows));
          } else
            res.json({
              records: rows.slice(0, 1000),
              nextCursor: rows.length > 1000 ? rows[999].id : null,
            });
        } catch (e) {
          next(e);
        }
      },
    );
  app.get('/api/assessments/:id/history', async (req: AuthRequest, res, next) => {
    try {
      const rows = await transaction(async (c) => {
        await allowed(c, req.actor!);
        return (
          await c.query(
            'SELECT id,actor_id AS "actorId",actor_name AS "actorName",created_at AS "createdAt",before_value AS before,after_value AS after FROM assessment_history WHERE workspace_id=$1 AND record_id=$2 ORDER BY created_at DESC,id DESC',
            [req.actor!.workspaceId, req.params.id],
          )
        ).rows;
      });
      res.json({ events: rows });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/assessments/batch', async (req: AuthRequest, res, next) => {
    try {
      const body = z
        .object({
          requestId: z.string().uuid(),
          confirmed: z.literal(true),
          edits: z.array(assessmentEdit).min(1).max(100),
        })
        .strict()
        .parse(req.body);
      if (new Set(body.edits.map(keyOf)).size !== body.edits.length)
        throw new ApiError(400, '批量对象重复');
      const result = await transaction(async (c) => {
        const a = req.actor!;
        await allowed(c, a, true);
        const digest = hash(JSON.stringify(body));
        const prior = await c.query(
          'SELECT actor_id,body_hash,result FROM assessment_submission WHERE workspace_id=$1 AND request_id=$2',
          [a.workspaceId, body.requestId],
        );
        if (prior.rowCount) {
          if (prior.rows[0].actor_id !== a.id || prior.rows[0].body_hash !== digest)
            throw new ApiError(409, '重复提交标识冲突');
          return prior.rows[0].result;
        }
        const state = await c.query(
          'SELECT data FROM workspace_state WHERE workspace_id=$1 FOR SHARE',
          [a.workspaceId],
        );
        const data = parseBackup(state.rows[0].data);
        const saved: Assessment[] = [];
        const now = new Date().toISOString();
        for (const edit of body.edits) {
          const params = [a.workspaceId, edit.date, edit.personId, edit.projectId, edit.tradeId];
          const old = (
            await c.query(
              'SELECT payload FROM daily_assessment WHERE workspace_id=$1 AND work_date=$2 AND person_id=$3 AND project_id=$4 AND trade_id=$5 FOR UPDATE',
              params,
            )
          ).rows[0]?.payload as Assessment | undefined;
          if ((old?.version ?? 0) !== edit.version)
            throw new ApiError(409, '考核记录已被他人修改，请刷新后重试；本次未保存');
          if (!old && !assessmentCandidates(data, edit.date).some((r) => keyOf(r) === keyOf(edit)))
            throw new ApiError(400, '请选择已登记并分配到该项目工种的施工人员');
          if (
            old &&
            Object.entries(edit.changes).every(
              ([field, value]) => old[field as 'photo' | 'cleaning' | 'attendance'] === value,
            )
          ) {
            saved.push(old);
            continue;
          }
          const record: Assessment = {
            ...(old ?? {
              id: randomUUID(),
              date: edit.date,
              personId: edit.personId,
              projectId: edit.projectId,
              tradeId: edit.tradeId,
              personName: data.people!.find((p) => p.id === edit.personId)!.name,
              projectName: data.projects.find((p) => p.id === edit.projectId)!.name,
              tradeName: data.trades.find((p) => p.id === edit.tradeId)!.name,
              attendance: 'pending',
              photo: 'pending',
              cleaning: 'pending',
              createdBy: a.id,
              createdName: a.displayName ?? a.login,
              createdAt: now,
            }),
            ...edit.changes,
            version: edit.version + 1,
            updatedBy: a.id,
            updatedName: a.displayName ?? a.login,
            updatedAt: now,
          };
          await c.query(
            'INSERT INTO daily_assessment(workspace_id,id,work_date,person_id,project_id,trade_id,version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,id) DO UPDATE SET version=$7,payload=$8',
            [
              a.workspaceId,
              record.id,
              record.date,
              record.personId,
              record.projectId,
              record.tradeId,
              record.version,
              JSON.stringify(record),
            ],
          );
          await c.query(
            'INSERT INTO assessment_history(id,workspace_id,record_id,actor_id,actor_name,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              randomUUID(),
              a.workspaceId,
              record.id,
              a.id,
              a.displayName ?? a.login,
              old ? JSON.stringify(old) : null,
              JSON.stringify(record),
            ],
          );
          saved.push(record);
        }
        const result = { records: saved };
        await c.query(
          'INSERT INTO assessment_submission(workspace_id,request_id,actor_id,body_hash,result) VALUES($1,$2,$3,$4,$5)',
          [a.workspaceId, body.requestId, a.id, digest, JSON.stringify(result)],
        );
        // General studio audit contains no private assessment outcomes or personnel names.
        await audit(c, a, 'assessment.save', undefined, {
          entityType: 'assessment',
          entityId: body.requestId,
          operation: 'update',
        });
        return result;
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
}
