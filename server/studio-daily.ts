import { rotationCommand, changeRotation } from '../src/lib/studio-rotation';
import type { Express } from 'express';
import { z } from 'zod';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit, hash } from './store';
import { canonical } from '../src/lib/history';
import { studioSettings, emptyStudio, studioDay, ruleActive } from '../src/lib/studio-daily';
import { assertStudioDailyReady } from './database-readiness';
export function studioDailyRoutes(app: Express) {
  app.get('/api/studio-daily', async (req: AuthRequest, res, next) => {
    try {
      const result = await transaction(async (c) => {
        await assertStudioDailyReady(c);
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
  const write: import('express').RequestHandler = async (request, res, next) => {
    const req = request as AuthRequest;
    const rotation = req.path.endsWith('/rotation');
    try {
      const b = z
        .object({
          requestId: z.uuid(),
          version: z.number().int().min(0),
          value: rotation ? rotationCommand : studioSettings,
        })
        .strict()
        .parse(req.body);
      const result = await transaction(async (c) => {
        await assertStudioDailyReady(c);
        const a = req.actor!;
        // Reuse the existing writable workspace lock row; cloud_workspace is SELECT-only
        // for the production app role. FOR UPDATE there would fail with SQLSTATE 42501.
        const locked = await c.query(
          'SELECT revision FROM workspace_state WHERE workspace_id=$1 FOR UPDATE',
          [a.workspaceId],
        );
        if (locked.rowCount !== 1)
          throw new ApiError(503, '工作空间状态未就绪；输入内容保留，请联系管理员');
        const digest = hash(canonical(rotation ? { rotation, body: b } : b));
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
          await c.query('SELECT version,value FROM studio_daily WHERE workspace_id=$1', [
            a.workspaceId,
          ])
        ).rows[0];
        if ((old?.version || 0) !== b.version)
          throw new ApiError(409, '设置已被其他负责人修改，请保留草稿并重新读取');
        let value: any;
        if (rotation) {
          try {
            value = {
              ...(old?.value || emptyStudio()),
              rotation: changeRotation(
                old?.value.rotation,
                b.value as any,
                b.requestId,
                new Date().toISOString(),
              ),
            };
          } catch (e) {
            throw new ApiError(400, (e as Error).message);
          }
        } else {
          value = b.value;
          if (value.rotation && canonical(value.rotation) !== canonical(old?.value.rotation))
            throw new ApiError(400, '轮值请使用专用操作，历史不能覆盖');
          if (old?.value.rotation) value = { ...value, rotation: old.value.rotation };
        }
        const people = [
          ...value.rules
            .filter(
              (r: any) =>
                canonical(r.people) !==
                canonical(old?.value.rules.find((x: any) => x.id === r.id)?.people),
            )
            .flatMap((r: any) => r.people),
          ...(rotation && (b.value as any).action === 'configure' ? value.rotation.people : []),
          ...(!rotation && canonical(value.weekly) !== canonical(old?.value.weekly)
            ? value.weekly.flat()
            : []),
          ...(!rotation && canonical(value.exceptions) !== canonical(old?.value.exceptions)
            ? value.exceptions.flatMap((x: any) => x.people)
            : []),
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
          [a.workspaceId, version, JSON.stringify(value), a.id],
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
          changedFields: rotation
            ? ['rotation:' + (b.value as any).action]
            : ['rules', 'weekly', 'exceptions', 'cleaning'],
        });
        return { version };
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  };
  app.put('/api/studio-daily', owner, write);
  app.post('/api/studio-daily/rotation', owner, write);
}
