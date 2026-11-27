import type { Express, Request, Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { canonical } from '../src/lib/history';
import { projectSchema, rememberNames } from '../src/lib/model';
import { workspaceStateWithProof } from './workspace-save';
import { designUrl } from '../src/lib/owner-design';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit, commit, getState, hash } from './store';

const projectId = z.string().min(1).max(100);
const fields = ['rendering', 'panorama'] as const;
const edit = z
  .object({
    rendering: z.string().max(1500),
    panorama: z.string().max(1500),
    version: z.number().int().nonnegative(),
    project: z
      .object({
        revision: z.number().int().nonnegative(),
        requestId: z.uuid(),
        value: projectSchema,
      })
      .strict()
      .optional(),
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
      rendering: designUrl(body.rendering.trim()),
      panorama: designUrl(body.panorama.trim()),
    };
    if (fields.some((field) => body[field].trim() && !accepted[field]))
      throw new ApiError(400, '请填写有效的 HTTPS 链接');
    const result = await transaction(async (c) => {
      const current = body.project && (await getState(c, actor.workspaceId, 'UPDATE'));
      const requestHash = body.project && hash(canonical({ target, body }));
      if (current && body.project) {
        if (body.project.value.id !== target) throw new ApiError(400, '项目编号不一致');
        const receipt = (
          await c.query(
            `SELECT after_value FROM audit_event WHERE workspace_id=$1 AND actor_id=$2
           AND action='owner.design.project-submit' AND entity_type='workspace_submission' AND entity_id=$3 LIMIT 1`,
            [actor.workspaceId, actor.id, body.project.requestId],
          )
        ).rows[0]?.after_value;
        if (receipt) {
          if (receipt.requestHash !== requestHash)
            throw new ApiError(409, '提交编号已用于其他修改');
          return {
            version: receipt.version as number,
            workspace: workspaceStateWithProof(current, actor),
          };
        }
        if (current.revision !== body.project.revision)
          throw new ApiError(409, '项目资料已更新，请核对后再保存');
      }
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
      const next = Number(old.version) + Number(changed.length > 0);
      if (changed.length) {
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
          after: {
            renderingPublished: !!accepted.rendering,
            panoramaPublished: !!accepted.panorama,
          },
        });
      }
      let workspace;
      if (current && body.project) {
        const prior = current.data.projects.find((p) => p.id === target);
        if (!prior) throw new ApiError(404, '项目不存在');
        if (body.project.value.updatedAt !== prior.updatedAt)
          throw new ApiError(409, '项目资料已更新，请核对后再保存');
        if (canonical(body.project.value) === canonical(prior)) {
          workspace = workspaceStateWithProof(current, actor);
        } else {
          const value = { ...body.project.value, updatedAt: new Date().toISOString() };
          const data = rememberNames(
            current.data,
            value.personnel,
            prior.personnel ?? { manager: prior.manager, worker: '', designer: '' },
          );
          workspace = workspaceStateWithProof(
            await commit(
              c,
              actor,
              current.revision,
              {
                ...data,
                projects: data.projects.map((p) => (p.id === target ? value : p)),
              },
              { prior: current },
            ),
            actor,
          );
        }
      }
      if (body.project && workspace)
        await audit(c, actor, 'owner.design.project-submit', workspace.revision, {
          entityType: 'workspace_submission',
          entityId: body.project.requestId,
          operation: 'submit',
          after: { requestHash, version: next },
        });
      return { version: next, workspace };
    });
    res.json({ ...accepted, ...result, origins });
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
    const rendering = designUrl(data.rendering, origins);
    const panorama = designUrl(data.panorama, origins);
    res.json({
      rendering,
      panorama,
      ...(data.rendering && !rendering ? { renderingUnavailable: true } : {}),
      ...(data.panorama && !panorama ? { panoramaUnavailable: true } : {}),
    });
  });
}
