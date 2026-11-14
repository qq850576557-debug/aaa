import type { Express } from 'express';
import { z } from 'zod';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit, hash } from './store';
import { canonical } from '../src/lib/history';
import { studioSettings, emptyStudio, studioDay, ruleActive } from '../src/lib/studio-daily';
export function studioDailyRoutes(app: Express) {
  app.get('/api/studio-daily', async (req: AuthRequest, res, next) => {
    try {
      const result = await transaction(async (c) => {
        const row = (
          await c.query(
            'SELECT version,value,updated_at AS "updatedAt" FROM studio_daily WHERE workspace_id=$1',
            [req.actor!.workspaceId],
          )
        ).rows[0];
        const users = (
          await c.query(
            "SELECT id,active,COALESCE(NULLIF(display_name,''),login) AS name FROM account WHERE workspace_id=$1 ORDER BY id",
            [req.actor!.workspaceId],
          )
        ).rows;
        const value = row?.value || emptyStudio();
        if (!req.actor!.owner)
          value.rules = value.rules.filter(
            (r: any) =>
              ruleActive(r, studioDay()) && (!r.people.length || r.people.includes(req.actor!.id)),
          );
        return {
          version: row?.version || 0,
          value,
          users,
          owner: req.actor!.owner,
          day: studioDay(),
          updatedAt: row?.updatedAt || null,
        };
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/studio-daily', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({ requestId: z.uuid(), version: z.number().int().min(0), value: studioSettings })
        .strict()
        .parse(req.body);
      const result = await transaction(async (c) => {
        const a = req.actor!;
        await c.query('SELECT id FROM cloud_workspace WHERE id=$1 FOR UPDATE', [a.workspaceId]);
        const digest = hash(canonical(b));
        const receipt = (
          await c.query(
            'SELECT * FROM studio_daily_submission WHERE workspace_id=$1 AND request_id=$2',
            [a.workspaceId, b.requestId],
          )
        ).rows[0];
        if (receipt) {
          if (receipt.actor_id !== a.id || receipt.body_hash !== digest)
            throw new ApiError(409, '重复提交编号冲突');
          return { version: receipt.version };
        }
        const old = (
          await c.query('SELECT version FROM studio_daily WHERE workspace_id=$1', [a.workspaceId])
        ).rows[0];
        if ((old?.version || 0) !== b.version)
          throw new ApiError(409, '设置已被其他负责人修改，请保留草稿并重新读取');
        const people = [
          ...b.value.rules.flatMap((r) => r.people),
          ...b.value.weekly.flat(),
          ...b.value.exceptions.flatMap((x) => x.people),
        ];
        const valid = new Set(
          (
            await c.query('SELECT id FROM account WHERE workspace_id=$1 AND active', [
              a.workspaceId,
            ])
          ).rows.map((r) => r.id),
        );
        if (people.some((id) => !valid.has(id)))
          throw new ApiError(400, '请选择当前工作室有效账号');
        const version = b.version + 1;
        await c.query(
          'INSERT INTO studio_daily VALUES($1,$2,$3,$4,now()) ON CONFLICT(workspace_id) DO UPDATE SET version=$2,value=$3,updated_by=$4,updated_at=now()',
          [a.workspaceId, version, JSON.stringify(b.value), a.id],
        );
        await c.query('INSERT INTO studio_daily_submission VALUES($1,$2,$3,$4,$5)', [
          a.workspaceId,
          b.requestId,
          a.id,
          digest,
          version,
        ]);
        await audit(c, a, 'studio.daily.update', undefined, {
          entityType: 'studio_daily',
          entityId: a.workspaceId,
          operation: 'update',
          changedFields: ['rules', 'weekly', 'exceptions', 'cleaning'],
        });
        return { version };
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
}
