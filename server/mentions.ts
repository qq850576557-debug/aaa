import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './auth';
import { pool, transaction } from './db';
import { ApiError, getState } from './store';
import { purchaseDue } from '../src/lib/model';

export function mentionRoutes(app: Express) {
  app.get('/api/mention-accounts', async (req: AuthRequest, res, next) => {
    try {
      const selected =
        z.string().max(5100).optional().parse(req.query.selected)?.split(',').filter(Boolean) ?? [];
      if (selected.length > 50) throw new ApiError(400, '关联账号数量过多');
      res.json({
        accounts: (
          await pool.query(
            `SELECT id,login,active,COALESCE(NULLIF(display_name,''),login) AS "displayName" FROM account WHERE workspace_id=$1 AND (active OR id=ANY($2::text[])) ORDER BY login`,
            [req.actor!.workspaceId, selected],
          )
        ).rows,
      });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/notifications', async (req: AuthRequest, res, next) => {
    try {
      const a = req.actor!;
      const limit = z.coerce.number().int().min(1).max(100).default(30).parse(req.query.limit);
      const before = z
        .string()
        .regex(/^\d{1,20}$/)
        .optional()
        .parse(req.query.before);
      res.json(
        await transaction(async (c) => ({
          unread: Number(
            (
              await c.query(
                'SELECT count(*) FROM mention_notification WHERE workspace_id=$1 AND recipient_id=$2 AND read_at IS NULL',
                [a.workspaceId, a.id],
              )
            ).rows[0].count,
          ),
          notifications: (
            await c.query(
              `SELECT id::text,actor_name AS "actorName",kind,record_id AS "recordId",project_id AS "projectId",project_name AS "projectName",title,summary,node_date AS date,created_at AS "createdAt",read_at AS "readAt" FROM mention_notification WHERE workspace_id=$1 AND recipient_id=$2 AND ($3::bigint IS NULL OR id<$3) ORDER BY id DESC LIMIT $4`,
              [a.workspaceId, a.id, before ?? null, limit],
            )
          ).rows,
        })),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/notifications/read', async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({
          ids: z
            .array(z.string().regex(/^\d{1,20}$/))
            .max(100)
            .optional(),
          all: z.literal(true).optional(),
        })
        .strict()
        .refine((x) => !!x.all || !!x.ids?.length)
        .parse(req.body);
      await pool.query(
        'UPDATE mention_notification SET read_at=now() WHERE workspace_id=$1 AND recipient_id=$2 AND read_at IS NULL AND ($3::boolean OR id=ANY($4::bigint[]))',
        [req.actor!.workspaceId, req.actor!.id, !!b.all, b.ids ?? []],
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/notifications/:id/target', async (req: AuthRequest, res, next) => {
    try {
      const id = z
          .string()
          .regex(/^\d{1,20}$/)
          .parse(req.params.id),
        a = req.actor!;
      res.json(
        await transaction(async (c) => {
          const n = (
            await c.query(
              'SELECT kind,record_id FROM mention_notification WHERE workspace_id=$1 AND recipient_id=$2 AND id=$3',
              [a.workspaceId, a.id, id],
            )
          ).rows[0];
          if (!n) throw new ApiError(404, '消息不存在或无权访问');
          const s = await getState(c, a.workspaceId);
          if (n.kind === 'purchase') {
            const p = s.data.purchases.find((p) => p.id === n.record_id);
            if (!p || !s.data.projects.some((x) => x.id === p.projectId))
              throw new ApiError(404, '原采购已移除，通知历史仍保留');
            return { kind: n.kind, value: { ...p, due: purchaseDue(p, s.data) } };
          }
          const r = (
            await c.query(
              `SELECT id,project_id AS "projectId",project_name AS "projectName",title,owner,mention_ids AS "mentionIds",node_date AS "nodeDate",status,notes,follow_up AS "followUp",version,deleted,created_by AS "createdBy",created_name AS "createdName",created_at AS "createdAt",updated_by AS "updatedBy",updated_name AS "updatedName",updated_at AS "updatedAt" FROM work_record WHERE workspace_id=$1 AND id=$2 AND NOT deleted`,
              [a.workspaceId, n.record_id],
            )
          ).rows[0];
          if (!r || !s.data.projects.some((p) => p.id === r.projectId))
            throw new ApiError(404, '原事项已移除，通知历史仍保留');
          return { kind: n.kind, value: r };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
