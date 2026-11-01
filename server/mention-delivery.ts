import type { PoolClient } from 'pg';
import { ApiError, type Actor } from './store';
export async function validateMentionAccounts(
  c: Pick<PoolClient, 'query'>,
  a: Actor,
  ids: string[],
  active = true,
) {
  if (!ids.length) return;
  const accounts = await c.query(
    'SELECT id FROM account WHERE workspace_id=$1 AND ($3::boolean=false OR active) AND id=ANY($2::text[])',
    [a.workspaceId, ids, active],
  );
  if (accounts.rows.length !== ids.length)
    throw new ApiError(
      400,
      active
        ? '被@账号已停用或不属于当前工作空间，请重新选择'
        : '历史关联包含当前工作空间无法识别的账号，请先核对账号映射；原始数据未覆盖',
    );
}
export async function syncMentions(
  c: Pick<PoolClient, 'query'>,
  a: Actor,
  kind: 'purchase' | 'record',
  id: string,
  before: string[],
  next: string[],
  project: { id: string; name: string },
  date: string,
  title: string,
  summary: string,
) {
  const added = [...new Set(next)].filter((x) => !before.includes(x));
  if (!added.length) return;
  await validateMentionAccounts(c, a, added);
  for (const recipient of added)
    await c.query(
      `INSERT INTO mention_notification(workspace_id,recipient_id,actor_id,actor_name,kind,record_id,project_id,project_name,title,summary,node_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,kind,record_id,recipient_id) DO NOTHING`,
      [
        a.workspaceId,
        recipient,
        a.id,
        a.displayName ?? a.login,
        kind,
        id,
        project.id,
        project.name,
        title,
        summary.slice(0, 240),
        date,
      ],
    );
}
