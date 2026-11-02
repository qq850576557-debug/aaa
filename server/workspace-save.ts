import {
  deltaResources,
  deltaKey,
  applyDeltaSide,
  type WorkspaceDelta,
} from '../src/lib/workspace-delta';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, audit, commit, getState, hash, type Actor } from './store';
import { canonical } from '../src/lib/history';
import { parseBackup, prepareWorkspace, type Data } from '../src/lib/model';
import { mergeWorkspace, type WorkspaceConflict } from '../src/lib/workspace-merge';
type State = Awaited<ReturnType<typeof getState>>;
export type WorkspaceSubmission = {
  revision: number;
  data: Data;
  base: Data;
  baseProof: string;
  requestId: string;
};
function proof(actor: Actor, revision: number, data: Data) {
  const secret = process.env.PRIVATE_DATA_KEY;
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new ApiError(500, '保存校验配置无效');
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update('chunmo/workspace-base/v1\0')
    .update(canonical({ workspace: actor.workspaceId, actor: actor.id, revision, data }))
    .digest('hex');
}
function resourceProof(actor: Actor, key: string, value: unknown) {
  const secret = process.env.PRIVATE_DATA_KEY;
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new ApiError(500, '保存校验配置无效');
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update('chunmo/workspace-resource/v1\0')
    .update(canonical({ workspace: actor.workspaceId, actor: actor.id, key, value }))
    .digest('hex');
}
export function workspaceStateWithProof(state: State, actor: Actor) {
  return {
    ...state,
    baseProof: proof(actor, state.revision, state.data),
    resourceProofs: Object.fromEntries(
      deltaResources(state.data).map((r) => [
        deltaKey(r),
        resourceProof(actor, deltaKey(r), r.after),
      ]),
    ),
  };
}
export class WorkspaceConflictError extends ApiError {
  constructor(
    public conflicts: WorkspaceConflict[],
    public current: ReturnType<typeof workspaceStateWithProof>,
    message = '保存冲突：相同内容已被他人修改，草稿已保留，请选择如何处理',
  ) {
    super(409, message);
  }
}
/** Preserve global transaction/CAS as a serialization guard; merge only verified field intents. */
export async function saveWorkspaceSubmission(
  c: Pick<PoolClient, 'query'>,
  actor: Actor,
  b: WorkspaceSubmission,
) {
  const current = await getState(c, actor.workspaceId, 'UPDATE');
  const requestHash = hash(canonical(b));
  const previous = await c.query(
    "SELECT after_value FROM audit_event WHERE workspace_id=$1 AND actor_id=$2 AND entity_type='workspace_submission' AND action='workspace.submit' AND entity_id=$3 LIMIT 1",
    [actor.workspaceId, actor.id, b.requestId],
  );
  if (previous.rowCount) {
    if (previous.rows[0].after_value?.requestHash !== requestHash)
      throw new ApiError(409, '重复提交编号对应不同内容，未执行操作');
    return workspaceStateWithProof(current, actor);
  }
  const expected = proof(actor, b.revision, b.base);
  if (
    !/^[a-f0-9]{64}$/i.test(b.baseProof) ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(b.baseProof, 'hex'))
  )
    throw new ApiError(403, '保存基线校验失败，草稿保留，请重新核对云端');
  if (b.revision > current.revision) throw new ApiError(409, '保存版本无效，未写入');
  return completeSubmission(c, actor, b, current, requestHash);
}
async function completeSubmission(
  c: Pick<PoolClient, 'query'>,
  actor: Actor,
  b: Pick<WorkspaceSubmission, 'base' | 'data' | 'requestId'>,
  current: State,
  requestHash: string,
) {
  const merged = mergeWorkspace(b.base, b.data, current.data);
  const latest = workspaceStateWithProof(current, actor);
  if (merged.conflicts.length) throw new WorkspaceConflictError(merged.conflicts, latest);
  let data: Data;
  try {
    data = prepareWorkspace(parseBackup(merged.data));
  } catch {
    throw new WorkspaceConflictError(
      [],
      latest,
      '关联或日期已变化，无法安全合并；草稿已保留，请检查项目、工种和记录关联',
    );
  }
  const result =
    canonical(data) === canonical(current.data)
      ? current
      : await commit(c, actor, current.revision, data, { prior: current });
  // Existing append-only audit storage is also the durable idempotency receipt, in this same transaction.
  await audit(c, actor, 'workspace.submit', result.revision, {
    entityType: 'workspace_submission',
    entityId: b.requestId,
    operation: 'submit',
    after: { requestHash },
    changedFields: [],
  });
  return workspaceStateWithProof(result, actor);
}

export async function saveWorkspaceDelta(
  c: Pick<PoolClient, 'query'>,
  actor: Actor,
  b: WorkspaceDelta,
) {
  const current = await getState(c, actor.workspaceId, 'UPDATE');
  const requestHash = hash(canonical(b));
  const previous = await c.query(
    "SELECT after_value FROM audit_event WHERE workspace_id=$1 AND actor_id=$2 AND entity_type='workspace_submission' AND action='workspace.submit' AND entity_id=$3 LIMIT 1",
    [actor.workspaceId, actor.id, b.requestId],
  );
  if (previous.rowCount) {
    if (previous.rows[0].after_value?.requestHash !== requestHash)
      throw new ApiError(409, '重复提交编号对应不同内容，未执行操作');
    return workspaceStateWithProof(current, actor);
  }
  if (b.revision > current.revision) throw new ApiError(409, '保存版本无效，未写入');
  const seen = new Set<string>();
  for (const change of b.changes) {
    const key = deltaKey(change);
    if (seen.has(key)) throw new ApiError(400, '重复的增量资源');
    seen.add(key);
    if (change.kind === 'record') {
      if (change.collection === 'workspace' || !change.id || change.id === '$order')
        throw new ApiError(400, '增量资源无效');
      for (const value of [change.before, change.after])
        if (
          value !== null &&
          (!value ||
            typeof value !== 'object' ||
            (value as any).id !== change.id ||
            Array.isArray(value))
        )
          throw new ApiError(400, '记录标识不一致');
    } else if (change.kind === 'order') {
      if (
        !['projects', 'people'].includes(change.collection) ||
        change.id !== '' ||
        ![change.before, change.after].every(
          (x) =>
            Array.isArray(x) &&
            x.every((y) => typeof y === 'string') &&
            new Set(x).size === x.length,
        )
      )
        throw new ApiError(400, '排序增量无效');
    } else if (
      change.collection !== 'workspace' ||
      !['nameHistory', 'recentColors'].includes(change.id)
    )
      throw new ApiError(400, '空间增量无效');
    if (change.before !== null || change.kind !== 'record') {
      const expected = resourceProof(actor, key, change.before);
      if (
        !change.proof ||
        !/^[a-f0-9]{64}$/i.test(change.proof) ||
        !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(change.proof, 'hex'))
      )
        throw new ApiError(403, '增量基线校验失败，原始草稿已保留');
    }
  }
  const base = applyDeltaSide(current.data, b.changes, 'before'),
    data = applyDeltaSide(current.data, b.changes, 'after');
  return completeSubmission(c, actor, { base, data, requestId: b.requestId }, current, requestHash);
}
