import { confirmEditorSnapshots } from './useEditorJournal';
import { durableRecord, startRecordSync, queueRecord } from './record-outbox';
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
export type CloudState = {
  data: Data;
  history: History;
  revision: number;
  baseProof: string;
  resourceProofs?: Record<string, string>;
};
export class CloudError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: {
      code?: string;
      httpStatus?: number;
      contentType?: string;
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
async function sendApi<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const saving =
    (path === '/workspace' && method === 'PUT') ||
    (/^\/records(?:\/[^/]+)?$/.test(path) && method !== 'GET');
  const controller = saving ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), WORKSPACE_SAVE_TIMEOUT)
    : undefined;
  try {
    const r = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(
              path === '/workspace' && method === 'PUT' && (body as any)?.delta
                ? (body as any).delta
                : body,
            ),
          }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    let value;
    try {
      value = await r.json();
    } catch {
      throw new CloudError(
        saving ? 0 : r.status,
        `云端响应不是有效JSON（HTTP ${r.status}，${(r.headers.get('content-type') ?? '未提供内容类型').split(';')[0]}）；${saving ? '保存结果尚未确认，将使用原提交编号核对' : '请检查API与反向代理配置'}`,
        {
          code: 'INVALID_API_RESPONSE',
          httpStatus: r.status,
          contentType: r.headers.get('content-type') ?? undefined,
        },
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CloudError(
        saving ? 0 : r.status,
        `云端响应结构无效（HTTP ${r.status}）；保存结果尚未确认`,
        { code: 'INVALID_API_RESPONSE', httpStatus: r.status },
      );
    if (!r.ok)
      throw new CloudError(
        r.status,
        value.error ?? '请求失败',
        path === '/workspace'
          ? { ...value, protocolVersion: r.headers.get('X-Chunmo-Workspace-Protocol') ?? 'unknown' }
          : value,
      );
    if (path === '/workspace' && method === 'PUT' && value.data)
      void confirmEditorSnapshots(value.data).catch(() => {});
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
export function cloudApi<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  if (
    /^\/records(?:\/[^/]+)?$/.test(path) &&
    ['POST', 'PUT', 'DELETE'].includes(method) &&
    (body as any)?.requestId
  )
    return durableRecord(path, method, body);
  return sendApi<T>(path, method, body);
}
export const queueCloudRecord = (path: string, method: string, body: unknown) =>
  queueRecord(path, method, body);
export async function cloudSession() {
  const s = await cloudApi<{ user: CloudUser; csrf: string }>('/auth/session');
  csrf = s.csrf;
  await confirmEditorSnapshots({});
  startRecordSync(s.user, sendApi);
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
