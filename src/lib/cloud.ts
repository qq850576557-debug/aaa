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
export type CloudState = { data: Data; history: History; revision: number };
export class CloudError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrf = '';
export async function cloudApi<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const r = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value;
  try {
    value = await r.json();
  } catch {
    throw new CloudError(r.status, '云端API不可用或响应无效');
  }
  if (!r.ok) throw new CloudError(r.status, value.error ?? '请求失败');
  return value;
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
