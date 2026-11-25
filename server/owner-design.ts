import type { Express, Request, Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { designUrl } from '../src/lib/owner-design';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit } from './store';

const projectId = z.string().min(1).max(100);
const fields = ['rendering', 'panorama'] as const;
const edit = z
  .object({
    rendering: z.string().max(1500),
    panorama: z.string().max(1500),
    version: z.number().int().nonnegative(),
  })
  .strict();

function designOrigins() {
  return [
    ...new Set(
      (process.env.CHUNMO_OWNER_DESIGN_ORIGINS ?? '').split(',').flatMap((entry) => {
        const candidate = entry.trim();
        try {
          const url = new URL(candidate);
          if (/^https:\/\/[a-z0-9.-]+\/?$/i.test(candidate) && /\.[a-z]{2,}$/i.test(url.hostname))
            return [url.origin];
        } catch {
          // Invalid entries grant no access.
        }
        return [];
      }),
    ),
  ];
}

export function ownerDesignStaffRoutes(app: Express) {
  if (process.env.CHUNMO_OWNER_DESIGN_ENABLED !== '1') return;
  const route = '/api/projects/:projectId/owner-design';
  app.get(route, owner, async (req: AuthRequest, res) => {
    const target = projectId.parse(req.params.projectId);
    const value = await transaction(
      async (c) =>
        (
          await c.query(
            `SELECT COALESCE(d.rendering,'') AS rendering,COALESCE(d.panorama,'') AS panorama,COALESCE(d.version,0) AS version
       FROM public.project p LEFT JOIN owner_portal.project_design d ON d.workspace_id=p.workspace_id AND d.project_id=p.id
       WHERE p.workspace_id=$1 AND p.id=$2`,
            [req.actor!.workspaceId, target],
          )
        ).rows[0],
    );
    if (!value) throw new ApiError(404, '项目不存在');
    res.json({ ...value, origins: designOrigins() });
  });
  app.put(route, owner, async (req: AuthRequest, res) => {
    const body = edit.parse(req.body);
    const actor = req.actor!,
      target = projectId.parse(req.params.projectId);
    const origins = designOrigins();
    const accepted = {
      rendering: designUrl(body.rendering.trim(), origins),
      panorama: designUrl(body.panorama.trim(), origins),
    };
    if (fields.some((field) => body[field].trim() && !accepted[field]))
      throw new ApiError(400, '请填写已配置微信业务域名下的 HTTPS 链接');
    const version = await transaction(async (c) => {
      const scope = [actor.workspaceId, target];
      const project = await c.query(
        'SELECT id FROM public.project WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        scope,
      );
      if (!project.rowCount) throw new ApiError(404, '项目不存在');
      const old = (
        await c.query(
          'SELECT rendering,panorama,version FROM owner_portal.project_design WHERE workspace_id=$1 AND project_id=$2',
          scope,
        )
      ).rows[0] ?? { rendering: '', panorama: '', version: 0 };
      if (old.version !== body.version) throw new ApiError(409, '设置已更新，请重新读取后再保存');
      const changed = fields.filter((field) => old[field] !== accepted[field]);
      if (!changed.length) return old.version as number;
      const next = old.version + 1;
      await c.query(
        `INSERT INTO owner_portal.project_design(workspace_id,project_id,rendering,panorama,version) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(workspace_id,project_id) DO UPDATE SET rendering=EXCLUDED.rendering,panorama=EXCLUDED.panorama,version=EXCLUDED.version`,
        [...scope, accepted.rendering, accepted.panorama, next],
      );
      await audit(c, actor, 'owner.design.update', undefined, {
        entityType: 'project',
        entityId: target,
        operation: 'update',
        changedFields: [...changed],
        after: { renderingPublished: !!accepted.rendering, panoramaPublished: !!accepted.panorama },
      });
      return next;
    });
    res.json({ ...accepted, version, origins });
  });
}

export function ownerDesignMiniRoutes(
  router: Router,
  db: Pool,
  current: (req: Request) => Promise<{ hash: string }>,
) {
  if (process.env.CHUNMO_OWNER_DESIGN_ENABLED !== '1') return;
  router.get('/projects/:projectId/design', async (req, res) => {
    const session = await current(req);
    const target = projectId.parse(req.params.projectId);
    const data = (
      await db.query('SELECT rendering,panorama FROM owner_portal.authorized_design($1,$2)', [
        session.hash,
        target,
      ])
    ).rows[0];
    if (!data) throw new ApiError(404, '当前住宅没有访问授权');
    const origins = designOrigins();
    res.json({
      rendering: designUrl(data.rendering, origins),
      panorama: designUrl(data.panorama, origins),
    });
  });
}
