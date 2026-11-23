import type { Express, Request, Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, commit, getState, hash, lockOwnerPurchases, type Actor } from './store';
import { purchaseSchema } from '../src/lib/model';
import { savePurchase } from '../src/lib/procurement';
import { workspaceStateWithProof } from './workspace-save';

const id = z.string().min(1).max(100);
const feedback = z
  .object({
    brand: z.string().trim().max(80),
    model: z.string().trim().max(80),
    note: z.string().trim().max(1000),
  })
  .strict();
const orderFeedback = feedback.extend({
  brand: z.string().trim().min(1, '请填写品牌').max(80),
  model: z.string().trim().min(1, '请填写型号').max(80),
});
const orderFields = orderFeedback.omit({ note: true });
const publication = z
  .object({
    responsibility: z.enum(['owner', 'company', 'supplier']),
    published: z.boolean(),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(4000),
    specification: z.string().trim().max(1000),
    quantity: z.string().trim().max(100),
    reference: z
      .string()
      .trim()
      .max(1000)
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password && !/\s/u.test(value);
        } catch {
          return false;
        }
      }, '参考资料请填写有效 HTTPS 链接'),
  })
  .strict()
  .refine(
    (value) => !value.published || value.responsibility === 'owner',
    '只有业主负责的采购可向业主发布',
  );
const stamp = { requestId: z.uuid(), version: z.string().regex(/^[a-f0-9]{32}$/) };
const reason = z.string().trim().min(1).max(1000);
const publish = z.object({ ...stamp, action: z.literal('publication'), publication }).strict();
const publicationUpdate = z.union([publication, z.object({ visible: z.boolean() }).strict()]);
const create = z
  .object({
    action: z.literal('create'),
    requestId: z.uuid(),
    revision: z.number().int().nonnegative(),
    purchase: purchaseSchema,
    publication: publicationUpdate,
    order: orderFields.optional(),
  })
  .strict();
const edit = z
  .object({
    ...stamp,
    action: z.literal('edit'),
    revision: z.number().int().nonnegative(),
    purchase: purchaseSchema.optional(),
    publication: publicationUpdate,
    order: orderFields.optional(),
  })
  .strict();
const markBought = z.object({ ...stamp, action: z.literal('purchase'), feedback }).strict();
const withdraw = z.object({ ...stamp, action: z.literal('withdraw') }).strict();
const staffInput = z.discriminatedUnion('action', [
  publish,
  create,
  edit,
  markBought,
  z
    .object({
      ...stamp,
      action: z.literal('order'),
      feedback: orderFeedback,
      reason: reason.optional(),
    })
    .strict(),
  z.object({ ...stamp, action: z.literal('reset') }).strict(),
  z.object({ ...stamp, action: z.literal('return'), reason }).strict(),
  z
    .object({
      ...stamp,
      action: z.literal('finish'),
      status: z.enum(['已到货', '已完成']).optional(),
    })
    .strict(),
  z
    .object({
      ...stamp,
      action: z.literal('reopen'),
      reason,
      status: z.enum(['待采购', '已下单']).optional(),
    })
    .strict(),
]);

function staffScope(c: PoolClient, actor: Actor, project: string) {
  return c
    .query<{ can_edit: boolean; service_enabled: boolean }>(
      `SELECT ($4::boolean OR coalesce(permission.can_write,false)) AS can_edit,
      coalesce(service.enabled,false) AS service_enabled
     FROM project p
     LEFT JOIN project_permission permission ON permission.workspace_id=p.workspace_id
       AND permission.project_id=p.id AND permission.account_id=$3
     LEFT JOIN owner_portal.project_service service ON service.workspace_id=p.workspace_id AND service.project_id=p.id
     WHERE p.workspace_id=$1 AND p.id=$2`,
      [actor.workspaceId, project, actor.id, actor.owner],
    )
    .then(({ rows }) => rows[0]);
}

async function staffPurchase(c: PoolClient, workspace: string, project: string, purchase: string) {
  const { rows } = await c.query(
    `SELECT id, internal_title AS "internalTitle", due, complete, etag AS version,
       coalesce(responsibility,'company') AS responsibility, coalesce(published,false) AS published,
       coalesce(title,internal_title) AS title, coalesce(description,'') AS description,
       coalesce(specification,'') AS specification, coalesce(quantity,'') AS quantity,
       coalesce(reference,'') AS reference, coalesce(bought,false) AS bought,
       coalesce(brand,'') AS brand, coalesce(model,'') AS model, coalesce(note,'') AS note,
       feedback_actor_name AS "feedbackActor", feedback_at AS "feedbackAt", return_reason AS "returnReason"
     FROM owner_portal.purchase_staff WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,
    [workspace, project, purchase],
  );
  return rows[0];
}

async function ensureInternalFeedback(c: PoolClient, key: string[], title: string) {
  await c.query(
    `INSERT INTO owner_portal.purchase_collaboration
     (workspace_id,project_id,purchase_id,responsibility,title,description,specification,quantity,reference)
     VALUES($1,$2,$3,'company',$4,'','','','') ON CONFLICT DO NOTHING`,
    [...key, title.trim().slice(0, 100)],
  );
}

async function recordFeedback(
  c: PoolClient,
  key: string[],
  actor: Actor,
  draft: z.infer<typeof feedback>,
  reason = '',
) {
  await c.query(
    `UPDATE owner_portal.purchase_collaboration SET version=version+1,bought=true,
     brand=$4,model=$5,note=$6,feedback_actor_id=$7,feedback_actor_name=$8,feedback_at=now(),return_reason=$9
     WHERE workspace_id=$1 AND project_id=$2 AND purchase_id=$3`,
    [
      ...key,
      draft.brand,
      draft.model,
      draft.note,
      actor.id,
      actor.displayName ?? actor.login,
      reason,
    ],
  );
}

export function staffOwnerPurchaseRoutes(app: Express) {
  const prefix = '/api/owner-purchases';
  app.get(prefix, async (req: AuthRequest, res) => {
    const actor = req.actor!;
    const result = await transaction(async (c) => {
      const { rows: projects } = await c.query<{ id: string; enabled: boolean }>(
        `SELECT p.id, coalesce(s.enabled,false) AS enabled FROM project p
         LEFT JOIN owner_portal.project_service s ON s.workspace_id=p.workspace_id AND s.project_id=p.id
         WHERE p.workspace_id=$1 AND ($3::boolean OR EXISTS (
           SELECT 1 FROM project_permission g WHERE g.workspace_id=p.workspace_id
           AND g.project_id=p.id AND g.account_id=$2 AND g.can_write))`,
        [actor.workspaceId, actor.id, actor.owner],
      );
      const { rows: items } = await c.query(
        `SELECT p.id,p.project_id AS "projectId",p.published,p.complete,p.bought,p.due
         FROM owner_portal.purchase_staff p
         WHERE p.workspace_id=$1 AND p.project_id=ANY($2) AND (p.published OR p.bought)
         ORDER BY p.due,p.id`,
        [actor.workspaceId, projects.map(({ id }) => id)],
      );
      return { projects, items };
    });
    res.json(result);
  });
  const itemRoute = prefix + '/:projectId/:purchaseId';
  app.get(itemRoute, async (req: AuthRequest, res) => {
    const actor = req.actor!,
      project = id.parse(req.params.projectId),
      purchase = id.parse(req.params.purchaseId);
    const { item, enabled } = await transaction(async (c) => {
      const scope = await staffScope(c, actor, project);
      if (!scope?.can_edit) throw new ApiError(403, '无此项目采购协同权限');
      const item = await staffPurchase(c, actor.workspaceId, project, purchase);
      if (!item) throw new ApiError(404, '采购尚未保存或已移除');
      return { item, enabled: scope.service_enabled };
    });
    res.json({ item, enabled });
  });
  app.post(itemRoute, async (req: AuthRequest, res) => {
    const input = staffInput.parse(req.body);
    const actor = req.actor!;
    const workspace = actor.workspaceId,
      project = id.parse(req.params.projectId),
      purchase = id.parse(req.params.purchaseId);
    const key = [workspace, project, purchase];
    const result = await transaction(async (c) => {
      const state = await getState(c, workspace, 'UPDATE');
      await lockOwnerPurchases(c, workspace);
      const scope = await staffScope(c, actor, project);
      if (!scope?.can_edit) throw new ApiError(403, '无此项目采购协同权限');
      const request = JSON.stringify({ fingerprint: hash(JSON.stringify(input)) });
      const receipt = await c.query(
        `SELECT input=$6::jsonb AS same FROM owner_portal.purchase_event
         WHERE workspace_id=$1 AND project_id=$2 AND purchase_id=$3 AND actor_kind='staff'
         AND actor_id=$4 AND request_id=$5`,
        [...key, actor.id, input.requestId, request],
      );
      if (receipt.rowCount) {
        if (!receipt.rows[0].same) throw new ApiError(409, '请求编号已被使用，请重新读取采购');
        const item = await staffPurchase(c, workspace, project, purchase);
        if (!item) throw new ApiError(404, '采购已移除');
        return {
          item,
          enabled: scope.service_enabled,
          ...(['create', 'edit'].includes(input.action)
            ? { workspace: workspaceStateWithProof(state, actor) }
            : {}),
        };
      }
      const before = await staffPurchase(c, workspace, project, purchase);
      const previousPurchase = state.data.purchases.find((row) => row.id === purchase);
      let savedState: Awaited<ReturnType<typeof getState>> | undefined;
      if (input.action === 'create') {
        if (
          before ||
          state.data.purchases.some((entry) => entry.id === purchase) ||
          input.purchase.id !== purchase ||
          input.purchase.projectId !== project
        )
          throw new ApiError(409, '采购已存在或所属项目有变，请重新读取');
        savedState = await commit(
          c,
          actor,
          input.revision,
          savePurchase(state.data, input.purchase),
          { prior: state },
        );
      } else if (!before || before.version !== input.version) {
        throw new ApiError(409, '采购已更新，请重新读取后再操作');
      }

      if (input.action === 'edit' && input.purchase) {
        if (input.purchase.id !== purchase || input.purchase.projectId !== project)
          throw new ApiError(409, '采购记录或所属项目有变，请重新读取');
        savedState = await commit(
          c,
          actor,
          input.revision,
          savePurchase(state.data, input.purchase),
          { prior: state },
        );
      }

      if (input.action === 'create' || input.action === 'edit' || input.action === 'publication') {
        const change = input.publication;
        const currentPurchase =
          savedState?.data.purchases.find((row) => row.id === purchase) ?? previousPurchase;
        const publicValue = (
          approved: string | undefined,
          previous: string | undefined,
          current: string | undefined,
          limit: number,
        ) =>
          approved && approved !== previous?.trim().slice(0, limit)
            ? approved
            : (current ?? '').trim().slice(0, limit);
        const fields =
          'visible' in change
            ? {
                // Compatibility with the existing database constraint; the editor only submits visibility.
                responsibility: 'owner',
                published: change.visible,
                title: (currentPurchase?.name ?? '').trim().slice(0, 100),
                description: before?.description ?? '',
                specification: publicValue(
                  before?.specification,
                  previousPurchase?.specification,
                  currentPurchase?.specification,
                  1000,
                ),
                quantity: publicValue(
                  before?.quantity,
                  previousPurchase?.quantity,
                  currentPurchase?.quantity,
                  100,
                ),
                reference: before?.reference ?? '',
              }
            : change;
        if (!fields.title) throw new ApiError(400, '请填写采购名称');
        if (fields.published && !scope.service_enabled)
          throw new ApiError(409, '请由负责人先开启本项目业主采购服务');
        await c.query(
          `INSERT INTO owner_portal.purchase_collaboration AS p
           (workspace_id,project_id,purchase_id,responsibility,published,title,description,specification,quantity,reference)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(workspace_id,project_id,purchase_id) DO UPDATE SET
           version=p.version+1, responsibility=excluded.responsibility, published=excluded.published,
           title=excluded.title,description=excluded.description,specification=excluded.specification,
           quantity=excluded.quantity,reference=excluded.reference`,
          [
            ...key,
            fields.responsibility,
            fields.published,
            fields.title,
            fields.description,
            fields.specification,
            fields.quantity,
            fields.reference,
          ],
        );
        if ('order' in input && input.order) {
          if (currentPurchase?.status !== '已下单' || before?.complete)
            throw new ApiError(409, '请先选择已下单');
          await recordFeedback(c, key, actor, { ...input.order, note: before?.note ?? '' });
        }
      } else {
        const existingFeedbackAction = input.action === 'purchase' || input.action === 'return';
        if (existingFeedbackAction && (!before.published || before.responsibility !== 'owner'))
          throw new ApiError(409, '采购当前未向业主发布');
        if (input.action === 'order' && before.complete && (!actor.owner || !input.reason))
          throw new ApiError(actor.owner ? 400 : 403, '重新开启采购须由负责人填写原因');
        if (
          input.action !== 'order' &&
          (input.action === 'reopen' ? !before.complete || !actor.owner : before.complete)
        )
          throw new ApiError(
            input.action === 'reopen' && !actor.owner ? 403 : 409,
            input.action === 'reopen' ? '仅负责人可重新开启已到货采购' : '采购已到货',
          );
        if (input.action === 'purchase') {
          if (!orderFeedback.safeParse(input.feedback).success)
            throw new ApiError(400, '请填写品牌和型号');
          await recordFeedback(c, key, actor, input.feedback);
        } else {
          if (!previousPurchase || previousPurchase.projectId !== project)
            throw new ApiError(409, '采购已移除或所属项目已变更');
          if (input.action === 'return' && !before.bought)
            throw new ApiError(409, '采购已处于待采购');
          if (input.action === 'finish' && !before.bought && previousPurchase.status !== '已下单')
            throw new ApiError(409, '请先确认下单，再确认到货');
          const status =
            input.action === 'finish'
              ? '已到货'
              : input.action === 'order'
                ? '已下单'
                : input.action === 'reopen'
                  ? (input.status ?? '待采购')
                  : '待采购';
          if (!before.published) await ensureInternalFeedback(c, key, previousPurchase.name);
          if (input.action === 'order')
            await recordFeedback(c, key, actor, input.feedback, input.reason);
          if (previousPurchase.status !== status)
            await commit(
              c,
              actor,
              state.revision,
              {
                ...state.data,
                purchases: state.data.purchases.map((row) =>
                  row.id === purchase ? { ...row, status } : row,
                ),
              },
              { prior: state, ownerPurchaseAction: purchase },
            );
          if (input.action === 'reopen' || input.action === 'reset' || input.action === 'return') {
            await c.query(
              `UPDATE owner_portal.purchase_collaboration SET version=version+1,bought=false,return_reason=$4
               WHERE workspace_id=$1 AND project_id=$2 AND purchase_id=$3`,
              [...key, input.action === 'reset' ? '' : input.reason],
            );
          }
        }
      }

      const item = await staffPurchase(c, workspace, project, purchase);
      await c.query(
        `INSERT INTO owner_portal.purchase_event
         (workspace_id,project_id,purchase_id,actor_kind,actor_id,actor_name,request_id,operation,input,before_value,after_value)
         VALUES($1,$2,$3,'staff',$4,$5,$6,$7,$8,$9,$10)`,
        [
          ...key,
          actor.id,
          actor.displayName ?? actor.login,
          input.requestId,
          input.action === 'create' || input.action === 'edit'
            ? 'publication'
            : input.action === 'order'
              ? 'purchase'
              : input.action === 'reset'
                ? 'return'
                : input.action,
          request,
          before ? JSON.stringify(before) : null,
          JSON.stringify(item),
        ],
      );
      return {
        item,
        enabled: scope.service_enabled,
        ...(input.action === 'create' || input.action === 'edit'
          ? { workspace: workspaceStateWithProof(savedState ?? state, actor) }
          : {}),
      };
    });
    res.json(result);
  });
}

export function ownerPurchaseRoutes(
  router: Router,
  db: Pick<PoolClient, 'query'>,
  current: (req: Request) => Promise<{ hash: string; id: string }>,
) {
  const base = '/projects/:projectId/purchases';
  router.get(base, async (req, res) => {
    const actor = await current(req);
    const project = id.parse(req.params.projectId);
    const { rows } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM owner_portal.available_project WHERE member_id=$2 AND id=$3) AS allowed,
       ARRAY(SELECT owner_portal.owner_purchases($1,$3)) AS items`,
      [actor.hash, actor.id, project],
    );
    if (!rows[0].allowed) throw new ApiError(404, '该住宅暂不可访问');
    res.json({ items: rows[0].items });
  });
  router.post(base + '/:purchaseId/feedback', async (req, res) => {
    if (!req.is('application/json')) throw new ApiError(415, '需要JSON请求');
    const actor = await current(req);
    const input = z.discriminatedUnion('action', [markBought, withdraw]).parse(req.body);
    if (input.action === 'purchase' && !orderFeedback.safeParse(input.feedback).success)
      throw new ApiError(400, '请填写品牌和型号');
    const project = id.parse(req.params.projectId),
      purchase = id.parse(req.params.purchaseId);
    const { rows } = await db.query(
      'SELECT owner_portal.owner_purchase_feedback($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        actor.hash,
        project,
        purchase,
        input.requestId,
        input.version,
        input.action,
        input.action === 'purchase' ? JSON.stringify(input.feedback) : null,
      ],
    );
    switch (rows[0].result) {
      case 'saved':
        res.json({ ok: true });
        return;
      case 'session':
        throw new ApiError(401, '业主登录已失效');
      case 'hidden':
        throw new ApiError(404, '此条采购已不可见');
      case 'limit':
        throw new ApiError(429, '操作频繁，请稍后重试');
      case 'conflict':
        throw new ApiError(409, '采购已更新，请重新读取后再操作');
      default:
        throw new ApiError(400, '购买信息校验失败');
    }
  });
}
