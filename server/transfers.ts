import type { Express } from 'express';
import type { AuthRequest } from './auth';
import { transaction } from './db';
import { permitted, load, history, alerts } from './materials';
import { ApiError, audit, hash } from './store';
import { randomUUID } from 'node:crypto';
import { transferCreate, transferAction, type Transfer } from '../src/lib/transfers';
import { milli, decimal, inventory, type MaterialEvent } from '../src/lib/materials';
import { today } from '../src/lib/model';
export function transferRoutes(app: Express) {
  app.get('/api/materials/transfers', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          await permitted(c, req.actor!);
          return {
            transfers: (
              await c.query(
                'SELECT payload FROM material_transfer WHERE workspace_id=$1 ORDER BY id',
                [req.actor!.workspaceId],
              )
            ).rows.map((r) => r.payload),
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  for (const create of [true, false])
    app.post(
      create ? '/api/materials/transfers' : '/api/materials/transfers/:id',
      async (req: AuthRequest, res, next) => {
        try {
          const b = create ? transferCreate.parse(req.body) : transferAction.parse(req.body),
            a = req.actor!;
          const result = await transaction(async (c) => {
            await permitted(c, a, true);
            const digest = hash(JSON.stringify({ id: req.params.id ?? null, body: b })),
              prior = (
                await c.query(
                  'SELECT body_hash,result FROM transfer_submission WHERE workspace_id=$1 AND request_id=$2',
                  [a.workspaceId, b.requestId],
                )
              ).rows[0];
            if (prior) {
              if (prior.body_hash !== digest) throw new ApiError(409, '重复请求标识冲突');
              return prior.result;
            }
            const { state, data } = await load(c, a);
            let t: Transfer,
              old: Transfer | null = null,
              kind: MaterialEvent['kind'] | null = null,
              q = '0';
            if ('projectId' in b) {
              if (
                b.projectId === b.targetProjectId ||
                ![b.projectId, b.targetProjectId].every((id) =>
                  data.projects.some((p) => p.id === id),
                ) ||
                !state.materials.some((m) => m.id === b.materialId && m.active) ||
                milli(b.quantity) <= 0n
              )
                throw new ApiError(400, '请选择不同的有效工地、在用规格及正数量');
              const handler = (
                await c.query(
                  "SELECT coalesce(nullif(display_name,''),login) AS name FROM account WHERE id=$1 AND workspace_id=$2 AND active",
                  [b.handlerId, a.workspaceId],
                )
              ).rows[0];
              if (!handler) throw new ApiError(400, '请选择本工作室有效经手账号');
              t = {
                ...b,
                id: randomUUID(),
                version: 1,
                status: '申请',
                sent: '0.000',
                received: '0.000',
                returned: '0.000',
                lost: '0.000',
                handlerName: handler.name,
                projectName: data.projects.find((p) => p.id === b.projectId)!.name,
                targetProjectName: data.projects.find((p) => p.id === b.targetProjectId)!.name,
                materialName: state.materials.find((m) => m.id === b.materialId)!.name,
                specification: state.materials.find((m) => m.id === b.materialId)!.specification,
                unit: state.materials.find((m) => m.id === b.materialId)!.unit,
                createdBy: a.id,
                createdName: a.displayName ?? a.login,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
            } else {
              old = (
                await c.query(
                  'SELECT payload FROM material_transfer WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
                  [a.workspaceId, req.params.id],
                )
              ).rows[0]?.payload;
              if (!old) throw new ApiError(404, '调拨单不存在');
              if (old.version !== b.version) throw new ApiError(409, '调拨版本冲突，请刷新');
              t = {
                ...old,
                version: old.version + 1,
                reason: b.reason,
                updatedAt: new Date().toISOString(),
              };
              if (b.action === 'approve') {
                if (t.status !== '申请') throw new ApiError(409, '当前不可批准');
                t.status = '待发出';
              }
              if (b.action === 'cancel') {
                if (!['申请', '待发出'].includes(t.status))
                  throw new ApiError(409, '已发出须登记在途退回，不能直接取消');
                t.status = '已取消';
              }
              if (b.action === 'dispatch') {
                if (t.status !== '待发出') throw new ApiError(409, '先批准再发出');
                q = t.quantity;
                kind = 'transfer_dispatch';
                t.sent = decimal(milli(q));
                t.status = '交接中';
              }
              if (['receive', 'return', 'loss'].includes(b.action)) {
                if (!['交接中', '部分接收'].includes(t.status))
                  throw new ApiError(409, '当前没有可处理在途材料');
                if (b.action === 'loss' && !a.owner)
                  throw new ApiError(403, '确认在途损耗仅负责人');
                const remain =
                  milli(t.sent) - milli(t.received) - milli(t.returned) - milli(t.lost);
                q = b.quantity;
                if (milli(q) <= 0n || milli(q) > remain)
                  throw new ApiError(409, '处理数量超过在途余量或无效');
                const key =
                  b.action === 'receive' ? 'received' : b.action === 'return' ? 'returned' : 'lost';
                t[key] = decimal(milli(t[key]) + milli(q));
                kind =
                  b.action === 'receive'
                    ? 'transfer_receive'
                    : b.action === 'return'
                      ? 'transfer_return'
                      : 'transfer_loss';
                if (b.action === 'receive') {
                  t.receiverId = a.id;
                  t.receiverName = a.displayName ?? a.login;
                  t.receivedAt = new Date().toISOString();
                }
                const remaining = remain - milli(q);
                t.status = remaining
                  ? '部分接收'
                  : milli(t.received) === milli(t.sent)
                    ? '已接收'
                    : milli(t.returned) === milli(t.sent)
                      ? '已取消'
                      : '差异关闭';
              }
            }
            if (kind) {
              const m = state.materials.find((m) => m.id === t.materialId),
                p = data.projects.find((p) => p.id === t.projectId),
                dest = data.projects.find((p) => p.id === t.targetProjectId);
              if (!m || !p || !dest) throw new ApiError(409, '原工地/材料已移除，请先恢复关联');
              const e: MaterialEvent = {
                requestId: b.requestId,
                id: randomUUID(),
                seq: state.events.reduce((n, e) => Math.max(n, e.seq), 0) + 1,
                kind,
                projectId: t.projectId,
                targetProjectId: t.targetProjectId,
                materialId: t.materialId,
                contextId: '',
                purchaseId: '',
                referenceId: t.id,
                date: today(),
                quantity: q,
                baseQty: decimal(milli(q)),
                inputUnit: m.unit,
                unit: m.unit,
                conversionFactor: '1',
                unitPrice: '0',
                reason: b.reason,
                actorId: a.id,
                actorName: a.displayName ?? a.login,
                at: new Date().toISOString(),
                projectName: p.name,
                materialName: m.name,
              };
              let inv;
              try {
                inv = inventory([...state.events, e]);
              } catch (err) {
                throw new ApiError(409, (err as Error).message);
              }
              e.costMicros = (inv.trace.get(e.id)?.cost ?? 0n).toString();
              await c.query('INSERT INTO material_event VALUES($1,$2,$3,$4,$5,$6)', [
                a.workspaceId,
                e.id,
                e.seq,
                e.requestId,
                hash(JSON.stringify(e)),
                JSON.stringify(e),
              ]);
              await history(c, a, e.id, null, e);
              await alerts(c, a, { ...state, events: [...state.events, e] }, data);
            }
            await c.query(
              'INSERT INTO material_transfer VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET version=$3,payload=$4',
              [a.workspaceId, t.id, t.version, JSON.stringify(t)],
            );
            await history(c, a, t.id, old, t);
            await audit(c, a, 'material.transfer');
            await c.query('INSERT INTO transfer_submission VALUES($1,$2,$3,$4)', [
              a.workspaceId,
              b.requestId,
              digest,
              JSON.stringify(t),
            ]);
            return t;
          });
          res.json(result);
        } catch (e) {
          next(e);
        }
      },
    );
}
