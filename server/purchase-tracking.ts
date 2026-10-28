import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ApiError, type Actor } from './store';
import { purchaseComplete, type Data } from '../src/lib/model';
export async function trackPurchases(
  c: Pick<PoolClient, 'query'>,
  a: Actor,
  before: Data,
  after: Data,
  imported = false,
) {
  for (const id of new Set([...before.purchases, ...after.purchases].map((p) => p.id))) {
    const old = before.purchases.find((p) => p.id === id),
      next = after.purchases.find((p) => p.id === id);
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    if (old && next && purchaseComplete(old) && !purchaseComplete(next) && !a.owner)
      throw new ApiError(403, '仅负责人可恢复已完成采购');
    const prior = (
      await c.query('SELECT * FROM purchase_record WHERE workspace_id=$1 AND id=$2', [
        a.workspaceId,
        id,
      ])
    ).rows[0];
    if (next && !a.owner && prior && purchaseComplete(prior.payload) && !purchaseComplete(next))
      throw new ApiError(403, '仅负责人可恢复历史完成采购');
    const operation = imported
      ? '历史导入/恢复'
      : !next
        ? '删除'
        : !old
          ? prior
            ? '恢复记录'
            : '创建'
          : !purchaseComplete(old) && purchaseComplete(next)
            ? '完成'
            : purchaseComplete(old) && !purchaseComplete(next)
              ? '恢复待采购'
              : '修改';
    // Legacy records have unknown creation/completion provenance, never invent it.
    const created = !old && !prior && !imported,
      completed =
        !!next &&
        purchaseComplete(next) &&
        (old ? !purchaseComplete(old) : !prior || !purchaseComplete(prior.payload)) &&
        !imported;
    await c.query(
      `INSERT INTO purchase_record(workspace_id,id,project_id,payload,created_by,created_name,created_at,updated_by,updated_name,completed_by,completed_name,completed_at,deleted)
   VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END,$8,$9,CASE WHEN $10 THEN $8 ELSE NULL END,CASE WHEN $10 THEN $9 ELSE NULL END,CASE WHEN $10 THEN now() ELSE NULL END,$11)
   ON CONFLICT(workspace_id,id) DO UPDATE SET project_id=excluded.project_id,payload=excluded.payload,updated_by=excluded.updated_by,updated_name=excluded.updated_name,updated_at=now(),deleted=excluded.deleted,
   completed_by=CASE WHEN $10 THEN $8 ELSE purchase_record.completed_by END,completed_name=CASE WHEN $10 THEN $9 ELSE purchase_record.completed_name END,completed_at=CASE WHEN $10 THEN now() ELSE purchase_record.completed_at END`,
      [
        a.workspaceId,
        id,
        (next ?? old)!.projectId,
        JSON.stringify(next ?? old),
        created ? a.id : null,
        created ? (a.displayName ?? a.login) : null,
        created,
        a.id,
        a.displayName ?? a.login,
        completed,
        !next,
      ],
    );
    await c.query(
      'INSERT INTO purchase_action(workspace_id,id,purchase_id,actor_id,actor_name,operation,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        a.workspaceId,
        randomUUID(),
        id,
        a.id,
        a.displayName ?? a.login,
        operation,
        old ? JSON.stringify(old) : null,
        next ? JSON.stringify(next) : null,
      ],
    );
  }
}
