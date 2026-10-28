import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit, hash, type Actor } from './store';
import { parseBackup, today, isHistorical, type Data } from '../src/lib/model';
import {
  materialSchema,
  projectMaterialSchema,
  contextSchema,
  eventSchema,
  convertQuantity,
  inventory,
  materialAnalysis,
  alertStatuses,
  csvRows,
  type MaterialState,
  type MaterialEvent,
  type MaterialAlert,
} from '../src/lib/materials';
async function permitted(c: PoolClient, a: Actor, write = false) {
  await c.query(
    `SELECT workspace_id FROM workspace_state WHERE workspace_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
    [a.workspaceId],
  );
  if (
    !a.owner &&
    !(
      await c.query('SELECT 1 FROM material_operator WHERE workspace_id=$1 AND account_id=$2', [
        a.workspaceId,
        a.id,
      ])
    ).rowCount
  )
    throw new ApiError(403, '材料资产仅负责人或获授权材料管理人可操作');
}
async function load(c: PoolClient, a: Actor) {
  const lists = [];
  for (const t of ['material_item', 'material_project_meta', 'material_context', 'material_alert'])
    lists.push(
      (
        await c.query(`SELECT id,version,payload FROM ${t} WHERE workspace_id=$1 ORDER BY id`, [
          a.workspaceId,
        ])
      ).rows.map((r) => ({ ...r.payload, id: r.id, version: r.version })),
    );
  const events = (
    await c.query('SELECT payload FROM material_event WHERE workspace_id=$1 ORDER BY seq', [
      a.workspaceId,
    ])
  ).rows.map((r) => r.payload);
  const data = parseBackup(
    (await c.query('SELECT data FROM workspace_state WHERE workspace_id=$1', [a.workspaceId]))
      .rows[0].data,
  );
  return {
    state: {
      materials: lists[0],
      projects: lists[1],
      contexts: lists[2],
      alerts: lists[3],
      events,
    } as MaterialState,
    data,
  };
}
async function history(c: PoolClient, a: Actor, id: string, before: unknown, after: unknown) {
  await c.query(
    'INSERT INTO material_history(workspace_id,id,entity_id,actor_id,actor_name,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      a.workspaceId,
      randomUUID(),
      id,
      a.id,
      a.displayName ?? a.login,
      before == null ? null : JSON.stringify(before),
      JSON.stringify(after),
    ],
  );
}
async function alerts(c: PoolClient, a: Actor, state: MaterialState, data: Data) {
  const analysis = materialAnalysis(state, data);
  const found = new Map(analysis.risks.map((r) => [r.key, r]));
  for (const r of analysis.risks) {
    const old = state.alerts.find((x) => x.key === r.key),
      fingerprint = hash(JSON.stringify(r));
    if (old?.fingerprint === fingerprint && !old.sourceResolved) continue;
    const value: MaterialAlert = {
      id: old?.id ?? randomUUID(),
      key: r.key,
      version: (old?.version ?? 0) + 1,
      projectId: r.projectId,
      materialId: r.materialId,
      contextId: r.contextId,
      status: old && old.fingerprint === fingerprint ? old.status : '待核查',
      assigneeId: old?.assigneeId ?? '',
      reason: old ? '源数据/比较条件变化，重新核查' : '自动核算触发',
      fingerprint,
      detail: r,
      sourceResolved: false,
      updatedAt: new Date().toISOString(),
      updatedBy: a.id,
    };
    await c.query(
      'INSERT INTO material_alert(workspace_id,id,version,payload) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET version=$3,payload=$4',
      [a.workspaceId, value.id, value.version, JSON.stringify(value)],
    );
    await history(c, a, value.id, old, value);
  }
  for (const old of state.alerts)
    if (!found.has(old.key) && !old.sourceResolved) {
      const value = {
        ...old,
        version: old.version + 1,
        sourceResolved: true,
        updatedAt: new Date().toISOString(),
        updatedBy: a.id,
      };
      await c.query(
        'UPDATE material_alert SET version=$3,payload=$4 WHERE workspace_id=$1 AND id=$2',
        [a.workspaceId, old.id, value.version, JSON.stringify(value)],
      );
      await history(c, a, old.id, old, value);
    }
  return analysis;
}
export function materialRoutes(app: Express) {
  app.get('/api/materials/access', async (req: AuthRequest, res, next) => {
    try {
      const a = req.actor!,
        q = await transaction((c) =>
          c.query('SELECT account_id FROM material_operator WHERE workspace_id=$1', [
            a.workspaceId,
          ]),
        );
      res.json({
        allowed: a.owner || q.rows.some((r) => r.account_id === a.id),
        owner: a.owner,
        ...(a.owner ? { operators: q.rows.map((r) => r.account_id) } : {}),
      });
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/materials/operators/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      await transaction(async (c) => {
        await permitted(c, req.actor!, true);
        if (
          !(
            await c.query('SELECT 1 FROM account WHERE workspace_id=$1 AND id=$2 AND active', [
              req.actor!.workspaceId,
              req.params.id,
            ])
          ).rowCount
        )
          throw new ApiError(404, '账号不存在');
        if (b.enabled)
          await c.query('INSERT INTO material_operator VALUES($1,$2) ON CONFLICT DO NOTHING', [
            req.actor!.workspaceId,
            req.params.id,
          ]);
        else
          await c.query('DELETE FROM material_operator WHERE workspace_id=$1 AND account_id=$2', [
            req.actor!.workspaceId,
            req.params.id,
          ]);
        await audit(c, req.actor!, 'material.grant');
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/materials/alerts', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          await permitted(c, req.actor!);
          return {
            alerts: (
              await c.query('SELECT payload FROM material_alert WHERE workspace_id=$1', [
                req.actor!.workspaceId,
              ])
            ).rows.map((r) => r.payload),
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/materials', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          await permitted(c, req.actor!);
          const { state, data } = await load(c, req.actor!);
          return { ...state, analysis: materialAnalysis(state, data) };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/materials/refresh-alerts', async (req: AuthRequest, res, next) => {
    try {
      await transaction(async (c) => {
        await permitted(c, req.actor!, true);
        const { state, data } = await load(c, req.actor!);
        await alerts(c, req.actor!, state, data);
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  for (const kind of ['items', 'projects', 'contexts'] as const)
    app.put('/api/materials/' + kind, async (req: AuthRequest, res, next) => {
      try {
        const b = z
          .object({
            id: z.string().max(100),
            version: z.number().int().nonnegative(),
            value:
              kind === 'items'
                ? materialSchema
                : kind === 'projects'
                  ? projectMaterialSchema
                  : contextSchema,
          })
          .strict()
          .parse(req.body);
        const value = await transaction(async (c) => {
          await permitted(c, req.actor!, true);
          if (kind === 'items' && !req.actor!.owner)
            throw new ApiError(403, '材料规格字典仅负责人维护');
          const { state, data } = await load(c, req.actor!),
            table =
              kind === 'items'
                ? 'material_item'
                : kind === 'projects'
                  ? 'material_project_meta'
                  : 'material_context',
            list =
              kind === 'items'
                ? state.materials
                : kind === 'projects'
                  ? state.projects
                  : state.contexts;
          const old = list.find((r: any) => (kind === 'projects' ? r.projectId : r.id) === b.id);
          if ((old?.version ?? 0) !== b.version)
            throw new ApiError(409, '配置已被修改，请刷新；本次未保存');
          if (!old && kind !== 'projects' && b.id) throw new ApiError(400, '新记录ID由服务器生成');
          let payload: any = b.value,
            id = b.id || randomUUID();
          if (kind === 'projects') {
            const p = data.projects.find((p) => p.id === id);
            if (!p) throw new ApiError(400, '项目不存在');
            payload = { ...payload, projectId: id, projectName: p.name };
          }
          if (kind === 'items') {
            const m = payload as z.infer<typeof materialSchema>;
            if (m.conversions.some((c) => Number(c.factor) <= 0))
              throw new ApiError(400, '换算系数必须大于零');
            if (
              old &&
              'category' in old &&
              (state.events.some((e) => e.materialId === id) ||
                state.contexts.some((x) => x.materialId === id)) &&
              JSON.stringify([
                old.category,
                old.unit,
                old.specification,
                old.performance,
                old.conversions,
              ]) !==
                JSON.stringify([m.category, m.unit, m.specification, m.performance, m.conversions])
            )
              throw new ApiError(
                409,
                '材料已被引用，不能改变类别、规格、单位、性能或换算；请新增独立规格',
              );
          }
          if (kind === 'contexts') {
            const x = payload as z.infer<typeof contextSchema>,
              p = data.projects.find((p) => p.id === x.projectId),
              t = data.tasks.find((t) => t.id === x.taskId);
            if (!p || !state.materials.some((m) => m.id === x.materialId))
              throw new ApiError(400, '项目或材料不存在');
            if (
              x.tradeId &&
              !data.trades.some((g) => g.id === x.tradeId && g.projectId === x.projectId)
            )
              throw new ApiError(400, '工种不属于该项目');
            if (
              x.taskId &&
              (!t || t.projectId !== x.projectId || (x.tradeId && t.tradeId !== x.tradeId))
            )
              throw new ApiError(400, '任务与项目/工种不匹配');
            if (x.staffIds.some((id) => !data.people?.some((p) => p.id === id && !p.deleted)))
              throw new ApiError(400, '请选择已登记人员');
            if (
              old &&
              'projectId' in old &&
              (old.projectId !== x.projectId ||
                ('materialId' in old && old.materialId !== x.materialId))
            )
              throw new ApiError(409, '核算对象不能换项目或材料');
            if (x.finalized && (x.progress !== 100 || !(t?.status === '已完成' || isHistorical(p))))
              throw new ApiError(409, '核算完成需进度100%，且关联任务或项目已完工');
            payload = { ...x, projectName: p.name };
          }
          const result = { ...payload, id, version: b.version + 1 };
          await c.query(
            `INSERT INTO ${table}(workspace_id,id,version,payload) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET version=$3,payload=$4`,
            [req.actor!.workspaceId, id, result.version, JSON.stringify(result)],
          );
          await history(c, req.actor!, id, old, result);
          const next = await load(c, req.actor!);
          await alerts(c, req.actor!, next.state, next.data);
          await audit(c, req.actor!, 'material.configure');
          return result;
        });
        res.json(value);
      } catch (e) {
        next(e);
      }
    });
  app.post('/api/materials/events', async (req: AuthRequest, res, next) => {
    try {
      const body = eventSchema.parse(req.body);
      const result = await transaction(async (c) => {
        const a = req.actor!;
        await permitted(c, a, true);
        const digest = hash(JSON.stringify(body)),
          prior = (
            await c.query(
              'SELECT body_hash,payload FROM material_event WHERE workspace_id=$1 AND request_id=$2',
              [a.workspaceId, body.requestId],
            )
          ).rows[0];
        if (prior) {
          if (prior.body_hash !== digest) throw new ApiError(409, '重复提交标识冲突');
          return prior.payload;
        }
        const { state, data } = await load(c, a),
          m = state.materials.find((m) => m.id === body.materialId),
          p = data.projects.find((p) => p.id === body.projectId);
        if (!m || !p) throw new ApiError(400, '材料/项目不存在');
        if (['opening', 'order', 'receipt'].includes(body.kind) && !m.active)
          throw new ApiError(409, '材料规格已停用');
        if (body.date > today()) throw new ApiError(400, '实际库存流水不能记在未来');
        if (['reverse', 'reopen'].includes(body.kind) && !a.owner)
          throw new ApiError(403, '冲销和重开仅负责人执行');
        if (body.kind === 'close' && !isHistorical(p)) throw new ApiError(409, '项目尚未完工');
        if (
          body.purchaseId &&
          !data.purchases.some((r) => r.id === body.purchaseId && r.projectId === p.id)
        )
          throw new ApiError(400, '采购事项不属于该项目');
        if (
          body.contextId &&
          !state.contexts.some(
            (x) => x.id === body.contextId && x.projectId === p.id && x.materialId === m.id,
          )
        )
          throw new ApiError(400, '施工阶段不属于此项目材料');
        if (body.kind === 'transfer' && !data.projects.some((p) => p.id === body.targetProjectId))
          throw new ApiError(400, '接收项目不存在');
        const before = inventory(state.events);
        for (const pid of [p.id, ...(body.kind === 'transfer' ? [body.targetProjectId] : [])]) {
          const s = before.stocks.get(JSON.stringify([pid, m.id]));
          if (body.kind !== 'order' && s && body.date < s.lastDate)
            throw new ApiError(409, '已有较晚库存流水，请按日期顺序录入或追加更正，不重写历史');
        }
        if (body.kind === 'reverse') {
          const original = state.events.find((e) => e.id === body.referenceId);
          if (original) {
            const ids = [original.projectId, original.targetProjectId].filter(Boolean);
            if (
              state.events.some(
                (e) =>
                  e.seq > original.seq &&
                  e.materialId === original.materialId &&
                  ids.some((id) => e.projectId === id || e.targetProjectId === id) &&
                  !['order', 'reverse'].includes(e.kind) &&
                  !before.reversed.has(e.id),
              )
            )
              throw new ApiError(
                409,
                '原流水后已有未冲销操作；请先处理后续流水，盘点后的更早差异须用核实调整',
              );
          }
        }
        let q: ReturnType<typeof convertQuantity>;
        try {
          q = convertQuantity(m, body.quantity, body.inputUnit);
        } catch (e) {
          throw new ApiError(400, (e as Error).message);
        }
        const event: MaterialEvent = {
          ...body,
          id: randomUUID(),
          seq: state.events.reduce((n, e) => Math.max(n, e.seq), 0) + 1,
          actorId: a.id,
          actorName: a.displayName ?? a.login,
          at: new Date().toISOString(),
          projectName: p.name,
          materialName: m.name,
          unit: m.unit,
          baseQty: q.quantity,
          conversionFactor: q.factor,
        };
        let computed: ReturnType<typeof inventory>;
        try {
          computed = inventory([...state.events, event]);
        } catch (e) {
          throw new ApiError(409, (e as Error).message);
        }
        event.costMicros = (
          computed.trace.get(event.id)?.cost ??
          (event.kind === 'reverse' ? -(before.trace.get(event.referenceId)?.cost ?? 0n) : 0n)
        ).toString();
        await c.query(
          'INSERT INTO material_event(workspace_id,id,seq,request_id,body_hash,payload) VALUES($1,$2,$3,$4,$5,$6)',
          [a.workspaceId, event.id, event.seq, event.requestId, digest, JSON.stringify(event)],
        );
        await history(c, a, event.id, null, event);
        await alerts(c, a, { ...state, events: [...state.events, event] }, data);
        await audit(c, a, 'material.event');
        return event;
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/materials/alerts/:id', async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({
          version: z.number().int().positive(),
          status: z.enum(alertStatuses),
          assigneeId: z.string().max(100),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(req.body);
      await transaction(async (c) => {
        await permitted(c, req.actor!, true);
        const { state } = await load(c, req.actor!),
          old = state.alerts.find((x) => x.id === req.params.id);
        if (!old) throw new ApiError(404, '预警不存在');
        if (old.version !== b.version) throw new ApiError(409, '预警已变化，请刷新后核查');
        const transitions: Record<string, string[]> = {
          待核查: ['核查中', '已确认正常', '已确认异常'],
          核查中: ['已确认正常', '已确认异常'],
          已确认正常: ['已关闭', '待核查'],
          已确认异常: ['已处理', '核查中'],
          已处理: ['已关闭', '核查中'],
          已关闭: ['待核查'],
        };
        if (old.status !== b.status && !transitions[old.status].includes(b.status))
          throw new ApiError(409, '请按核查、确认、处理、复核关闭顺序操作');
        if (
          b.assigneeId &&
          !(
            await c.query('SELECT 1 FROM account WHERE workspace_id=$1 AND id=$2 AND active', [
              req.actor!.workspaceId,
              b.assigneeId,
            ])
          ).rowCount
        )
          throw new ApiError(400, '责任账号不属于此工作室');
        const value = {
          ...old,
          ...b,
          version: old.version + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: req.actor!.id,
        };
        await c.query(
          'UPDATE material_alert SET version=$3,payload=$4 WHERE workspace_id=$1 AND id=$2',
          [req.actor!.workspaceId, old.id, value.version, JSON.stringify(value)],
        );
        await history(c, req.actor!, old.id, old, value);
        await audit(c, req.actor!, 'material.alert');
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/materials/history/:id', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          await permitted(c, req.actor!);
          return {
            events: (
              await c.query(
                'SELECT id,actor_id AS "actorId",actor_name AS "actorName",at,before_value AS before,after_value AS after FROM material_history WHERE workspace_id=$1 AND entity_id=$2 ORDER BY at DESC,id DESC',
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
  app.get('/api/materials/export', async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({
          projectId: z.string().max(100).optional(),
          materialId: z.string().max(100).optional(),
          category: z.string().max(100).optional(),
          projectType: z.string().max(100).optional(),
          from: z.string().refine(dateOK).optional(),
          to: z.string().refine(dateOK).optional(),
        })
        .strict()
        .parse(req.query);
      const csv = await transaction(async (c) => {
        await permitted(c, req.actor!);
        const { state } = await load(c, req.actor!);
        const rows = state.events.filter(
          (e) =>
            (!b.projectId || e.projectId === b.projectId || e.targetProjectId === b.projectId) &&
            (!b.materialId || e.materialId === b.materialId) &&
            (!b.category ||
              state.materials.find((m) => m.id === e.materialId)?.category === b.category) &&
            (!b.projectType ||
              (state.projects.find((p) => p.projectId === e.projectId)?.projectType || '未设置') ===
                b.projectType) &&
            (!b.from || e.date >= b.from) &&
            (!b.to || e.date <= b.to),
        );
        if (rows.length > 50000) throw new ApiError(400, '导出超过50000条，请缩小范围');
        return csvRows([
          [
            '流水ID',
            '顺序',
            '日期',
            '项目ID',
            '项目',
            '材料ID',
            '材料',
            '类型',
            '施工阶段ID',
            '调入项目ID',
            '原始数量',
            '原始单位',
            '换算系数',
            '基准数量',
            '基准单位',
            '账面价值（微元）',
            '采购关联',
            '盘点/冲销引用',
            '操作人ID',
            '操作人',
            '服务器时间',
            '原因',
          ],
          ...rows.map((e) => [
            e.id,
            e.seq,
            e.date,
            e.projectId,
            e.projectName,
            e.materialId,
            e.materialName,
            e.kind,
            e.contextId,
            e.targetProjectId,
            e.quantity,
            e.inputUnit,
            e.conversionFactor,
            e.baseQty,
            e.unit,
            e.costMicros,
            e.purchaseId,
            e.referenceId,
            e.actorId,
            e.actorName,
            e.at,
            e.reason,
          ]),
        ]);
      });
      res.type('text/csv; charset=utf-8').attachment('chunmo-material-ledger.csv').send(csv);
    } catch (e) {
      next(e);
    }
  });
}
import { dateOK } from '../src/lib/model';
