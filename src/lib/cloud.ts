import type { Data } from './model';
import type { History } from './history';
export type CloudUser = {
  id: string;
  workspaceId: string;
  login: string;
  displayName?: string;
  avatarVersion?: string | null;
  cardAvatarVersion?: string | null;
  owner: boolean;
};
export type CloudState = { data: Data; history: History; revision: number; baseProof: string };
export class CloudError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: {
      code?: string;
      protocolVersion?: string;
      issues?: import('./workspace-save-plan').ValidationIssue[];
      conflicts?: import('./workspace-merge').WorkspaceConflict[];
      current?: CloudState;
    },
  ) {
    super(message);
  }
}
let csrf = '';
export const WORKSPACE_SAVE_TIMEOUT = 30000;
export async function cloudApi<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const saving = path === '/workspace' && method === 'PUT';
  const controller = saving ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), WORKSPACE_SAVE_TIMEOUT)
    : undefined;
  try {
    const r = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    let value;
    try {
      value = await r.json();
    } catch {
      throw new CloudError(saving ? 0 : r.status, '云端API不可用或响应无效；保存结果尚未确认');
    }
    if (!r.ok)
      throw new CloudError(
        r.status,
        value.error ?? '请求失败',
        path === '/workspace'
          ? { ...value, protocolVersion: r.headers.get('X-Chunmo-Workspace-Protocol') ?? 'unknown' }
          : value,
      );
    return value;
  } catch (error) {
    if (controller?.signal.aborted)
      throw new CloudError(0, '云端保存响应超时，正在保留草稿并使用原提交编号安全重试');
    if (saving && !(error instanceof CloudError))
      throw new CloudError(0, '网络连接暂时中断，保存结果尚未确认');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export async function cloudSession() {
  const s = await cloudApi<{ user: CloudUser; csrf: string }>('/auth/session');
  csrf = s.csrf;
  return s.user;
}
export function inCloud() {
  try {
    return sessionStorage.getItem('chunmo-space') === 'cloud';
  } catch {
    return false;
  }
}
export function selectSpace(mode: 'cloud' | 'local') {
  sessionStorage.setItem('chunmo-space', mode);
  window.location.reload();
}
