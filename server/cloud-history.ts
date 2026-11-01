import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit, commit, getState, hash, type Actor } from './store';
import { canonical, changed, snapshot } from '../src/lib/history';
import { safeActorDisplayName } from './audit';
export async function captureRestoreBackup(c: PoolClient, w: string) {
  const state = (await c.query('SELECT * FROM workspace_state WHERE workspace_id=$1', [w])).rows[0];
  const records = (await c.query('SELECT * FROM work_record WHERE workspace_id=$1', [w])).rows;
  return {
    format: 'chunmo-before-restore',
    version: 1,
    state,
    records,
    at: new Date().toISOString(),
  };
}
export async function persistRestoreBackup(
  c: PoolClient,
  a: Actor,
  requestId: string,
  digest: string,
  backup: unknown,
  result: unknown,
) {
  try {
    await c.query(
      'INSERT INTO cloud_restore_backup(workspace_id,request_id,actor_id,body_hash,backup,result) VALUES($1,$2,$3,$4,$5,$6)',
      [a.workspaceId, requestId, a.id, digest, JSON.stringify(backup), JSON.stringify(result)],
    );
  } catch {
    throw new ApiError(503, '恢复前备份保存失败，本次恢复已回滚；请稍后重试');
  }
}
export function cloudHistoryRoutes(app: Express) {
  app.get('/api/history/versions', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          const w = req.actor!.workspaceId,
            s = await getState(c, w);
          const metadata = (
            await c.query(
              'SELECT node_id,revision FROM workspace_history_revision WHERE workspace_id=$1',
              [w],
            )
          ).rows;
          const versionById = new Map(metadata.map((m) => [m.node_id, m.revision]));
          const records = (
            await c.query(
              `SELECT v.record_id,v.version,v.at,v.actor_name,v.baseline,v.snapshot,r.version current_version,EXISTS(SELECT 1 FROM audit_event e WHERE e.workspace_id=v.workspace_id AND e.entity_id=v.record_id AND e.action='record.restore' AND e.after_value->>'version'=v.version::text) restored FROM record_version v JOIN work_record r ON r.workspace_id=v.workspace_id AND r.id=v.record_id WHERE v.workspace_id=$1 AND v.at>=now()-interval '15 days' ORDER BY v.at DESC`,
              [w],
            )
          ).rows;
          const legacyEvents = (
            await c.query(
              `SELECT h.id,h.record_id,h.at,h.actor_name,h.operation FROM record_history h WHERE h.workspace_id=$1 AND h.at>=now()-interval '15 days' AND NOT EXISTS(SELECT 1 FROM record_version v WHERE v.workspace_id=h.workspace_id AND v.record_id=h.record_id AND v.at=h.at)`,
              [w],
            )
          ).rows;
          return {
            revision: s.revision,
            nodes: [
              ...legacyEvents.map((h) => ({
                kind: 'record-log',
                id: String(h.id),
                recordId: h.record_id,
                version: null,
                at: h.at,
                actor: h.actor_name,
                name: '既有事项变更记录',
                status: h.operation,
                summary: '旧版仅有修改摘要，无可恢复内容快照',
              })),
              ...s.history.records.map((r) => ({
                kind: 'workspace',
                id: r.id,
                at: r.at,
                actor: r.actor,
                name: r.name,
                status: r.action,
                version: versionById.get(r.id) ?? null,
                summary: [...new Set(r.changes.map((x) => x.module))].join('、'),
                scope: r.scope,
              })),
              ...records.map((r) => ({
                kind: 'record',
                id: r.record_id + ':' + r.version,
                recordId: r.record_id,
                version: r.version,
                currentVersion: r.current_version,
                at: r.at,
                actor: r.actor_name,
                name: r.snapshot.title,
                status: r.restored
                  ? '恢复事项'
                  : r.baseline
                    ? '已有版本基线'
                    : r.snapshot.deleted
                      ? '删除'
                      : r.version === 1
                        ? '新增事项'
                        : '修改事项',
                summary: r.snapshot.project_name + ' · 事项管理',
              })),
            ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/history/versions/:kind/:id', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          const w = req.actor!.workspaceId;
          if (req.params.kind === 'record-log') {
            const event = (
              await c.query(
                `SELECT id,record_id,at,actor_name,operation,changed_fields,before_value,after_value FROM record_history WHERE workspace_id=$1 AND id::text=$2 AND at>=now()-interval '15 days'`,
                [w, req.params.id],
              )
            ).rows[0];
            if (!event) throw new ApiError(404, '历史摘要不存在或已过期');
            return { content: event };
          }
          if (req.params.kind === 'workspace') {
            const s = await getState(c, w);
            const r = s.history.records.find((x) => x.id === req.params.id);
            if (!r) throw new ApiError(404, '版本已过期或不存在');
            return {
              node: r,
              content: s.history.snapshots[r.after],
              before: s.history.snapshots[r.before],
              currentRevision: s.revision,
            };
          }
          const id = String(req.params.id),
            split = id.lastIndexOf(':');
          const q = await c.query(
            `SELECT snapshot,version,at,actor_name FROM record_version WHERE workspace_id=$1 AND record_id=$2 AND version=$3 AND at>=now()-interval '15 days'`,
            [w, id.slice(0, split), Number(id.slice(split + 1))],
          );
          if (!q.rowCount) throw new ApiError(404, '版本已过期或不存在');
          return { content: q.rows[0].snapshot, node: q.rows[0] };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/history/restore-backups/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      const q = await transaction((c) =>
        c.query('SELECT backup FROM cloud_restore_backup WHERE workspace_id=$1 AND request_id=$2', [
          req.actor!.workspaceId,
          req.params.id,
        ]),
      );
      if (!q.rowCount) throw new ApiError(404, '备份不存在');
      res.json(q.rows[0].backup);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/history/versions/restore', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z
          .object({
            requestId: z.uuid(),
            kind: z.enum(['workspace', 'record']),
            id: z.string().min(1).max(200),
            revision: z.number().int().min(0),
            currentVersion: z.number().int().positive().optional(),
          })
          .strict()
          .parse(req.body),
        a = req.actor!,
        digest = hash(canonical(b));
      res.json(
        await transaction(async (c) => {
          const s = await getState(c, a.workspaceId, 'UPDATE');
          const old = (
            await c.query(
              'SELECT * FROM cloud_restore_backup WHERE workspace_id=$1 AND request_id=$2',
              [a.workspaceId, b.requestId],
            )
          ).rows[0];
          if (old) {
            if (old.actor_id !== a.id || old.body_hash !== digest)
              throw new ApiError(409, '请求编号已用于其他恢复');
            return old.result;
          }
          if (s.revision !== b.revision)
            throw new ApiError(409, '当前数据已更新，请重新读取历史；未恢复或覆盖数据');
          const backup = await captureRestoreBackup(c, a.workspaceId);
          let revision = s.revision;
          if (b.kind === 'workspace') {
            const r = s.history.records.find((x) => x.id === b.id);
            if (!r) throw new ApiError(404, '版本已过期或不存在');
            if (!changed(snapshot(s.data, r.scope), s.history.snapshots[r.after]))
              throw new ApiError(409, '所选版本与当前内容相同，无需恢复');
            revision = (
              await commit(c, a, s.revision, s.data, { restoreId: b.id, restoreAfter: true })
            ).revision;
          } else {
            const split = b.id.lastIndexOf(':'),
              id = b.id.slice(0, split),
              v = Number(b.id.slice(split + 1));
            const current = (
              await c.query(
                'SELECT * FROM work_record WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
                [a.workspaceId, id],
              )
            ).rows[0];
            if (!current || current.version !== b.currentVersion)
              throw new ApiError(409, '事项已经更新，请重新核对；未覆盖当前记录');
            const target = (
              await c.query(
                `SELECT snapshot FROM record_version WHERE workspace_id=$1 AND record_id=$2 AND version=$3 AND at>=now()-interval '15 days'`,
                [a.workspaceId, id, v],
              )
            ).rows[0]?.snapshot;
            if (!target) throw new ApiError(404, '事项版本已过期或不存在');
            if (!s.data.projects.some((p) => p.id === target.project_id))
              throw new ApiError(409, '原项目已移除，请先核对项目关联');
            const fields = [
              'project_id',
              'project_name',
              'title',
              'node_date',
              'status',
              'notes',
              'follow_up',
              'owner',
              'deleted',
            ];
            target.project_name = s.data.projects.find((p) => p.id === target.project_id)!.name;
            if (fields.filter((f) => f !== 'project_name').every((f) => current[f] === target[f]))
              throw new ApiError(409, '所选版本与当前内容相同，无需恢复');
            await c.query(
              `UPDATE work_record SET ${fields.map((f, i) => f + '=$' + (i + 3)).join(',')},version=version+1,updated_by=$12,updated_name=$13,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
              [
                a.workspaceId,
                id,
                ...fields.map((f) => target[f]),
                a.id,
                safeActorDisplayName(a.displayName ?? a.login),
              ],
            );
            await c.query(
              `INSERT INTO record_history(workspace_id,record_id,actor_id,actor_name,operation,changed_fields,before_value,after_value) VALUES($1,$2,$3,$4,'update',$5,$6,$7)`,
              [
                a.workspaceId,
                id,
                a.id,
                safeActorDisplayName(a.displayName ?? a.login),
                JSON.stringify(['历史恢复']),
                JSON.stringify({
                  projectId: current.project_id,
                  nodeDate: current.node_date,
                  status: current.status,
                }),
                JSON.stringify({
                  projectId: target.project_id,
                  nodeDate: target.node_date,
                  status: target.status,
                }),
              ],
            );
            await audit(c, a, 'record.restore', undefined, {
              entityType: 'record',
              entityId: id,
              operation: 'restore',
              after: { version: current.version + 1, sourceVersion: v },
              changedFields: ['历史恢复'],
            });
          }
          const result = { backupId: b.requestId, revision, source: { kind: b.kind, id: b.id } };
          await persistRestoreBackup(c, a, b.requestId, digest, backup, result);
          return result;
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
