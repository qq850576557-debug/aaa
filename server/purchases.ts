import type { Express } from 'express';
import type { AuthRequest } from './auth';
import { transaction } from './db';
export function purchaseRoutes(app: Express) {
  app.get('/api/purchase-records', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => ({
          records: (
            await c.query(
              `SELECT id,created_name AS "createdName",created_at AS "createdAt",updated_name AS "updatedName",updated_at AS "updatedAt",completed_name AS "completedName",completed_at AS "completedAt",deleted FROM purchase_record WHERE workspace_id=$1`,
              [req.actor!.workspaceId],
            )
          ).rows,
        })),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/purchase-records/:id/history', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => ({
          events: (
            await c.query(
              `SELECT actor_id AS "actorId",actor_name AS "actorName",at,operation,before_value AS before,after_value AS after FROM purchase_action WHERE workspace_id=$1 AND purchase_id=$2 ORDER BY at,id`,
              [req.actor!.workspaceId, req.params.id],
            )
          ).rows,
        })),
      );
    } catch (e) {
      next(e);
    }
  });
}
