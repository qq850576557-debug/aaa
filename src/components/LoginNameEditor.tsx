import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { cloudApi, CloudError } from '../lib/cloud';
import { loginSchema, LOGIN_HELP } from '../lib/login';
import { PASSWORD_MIN, PASSWORD_MAX, passwordSchema } from '../lib/password';
type LoginPolicy = {
  login: string;
  lastChangedAt: string | null;
  nextAllowedAt: string | null;
  canChange: boolean;
  serverNow: string;
};
const dateLabel = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '现在可修改';
export function LoginNameEditor({ dirty, onExpired }: { dirty: boolean; onExpired: () => void }) {
  const [policy, setPolicy] = useState<LoginPolicy | null>(null),
    [error, setError] = useState('');
  const [newLogin, setNewLogin] = useState(''),
    [candidate, setCandidate] = useState('');
  const [password, setPassword] = useState(''),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setPolicy(await cloudApi<LoginPolicy>('/auth/login-policy'));
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function preview(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (dirty) {
      setError('请先保存当前修改或备份草稿，再修改登录账号');
      return;
    }
    const checked = loginSchema.safeParse(newLogin);
    if (!checked.success) {
      setError(checked.error.issues[0].message);
      return;
    }
    if (checked.data === policy?.login) {
      setError('新账号与当前账号相同');
      return;
    }
    setCandidate(checked.data);
    setPassword('');
    setConfirming(true);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const checked = passwordSchema.safeParse(password);
    if (!checked.success) {
      setError(checked.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const result = await cloudApi<{ login: string }>('/auth/login-name', 'POST', {
        newLogin: candidate,
        currentPassword: password,
        confirm: true,
      });
      setPassword('');
      setConfirming(false);
      onExpired();
      window.dispatchEvent(
        new CustomEvent('chunmo-auth-expired', {
          detail: { login: result.login, clearWorkspace: true },
        }),
      );
    } catch (e) {
      setPassword('');
      if (e instanceof CloudError && e.status === 401) {
        setConfirming(false);
        onExpired();
      } else {
        setError(String(e));
        await load();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <details className="account-card login-name-editor">
        <summary>修改登录账号</summary>
        <p className="account-muted">登录账号用于登录，与可随时修改的正式展示名称不同。</p>
        <dl className="login-policy">
          <div>
            <dt>当前登录账号</dt>
            <dd>{policy?.login ?? '正在读取…'}</dd>
          </div>
          <div>
            <dt>上次修改</dt>
            <dd>{policy?.lastChangedAt ? dateLabel(policy.lastChangedAt) : '尚未修改'}</dd>
          </div>
          <div>
            <dt>下次允许修改</dt>
            <dd>{policy ? dateLabel(policy.nextAllowedAt) : '正在读取…'}</dd>
          </div>
        </dl>
        <form aria-label="修改登录账号" onSubmit={preview}>
          <label>
            新登录账号
            <input
              aria-label="新登录账号"
              required
              autoComplete="off"
              maxLength={160}
              value={newLogin}
              onChange={(e) => setNewLogin(e.target.value)}
              disabled={!policy?.canChange || busy}
            />
          </label>
          <p className="account-muted">{LOGIN_HELP} 全角字符将规范化，英文字母不区分大小写。</p>
          {!policy?.canChange && policy && <p role="status">90天冷却期内，暂不能再次修改。</p>}
          {error && !confirming && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={!policy?.canChange || busy}>继续修改登录账号</button>
        </form>
      </details>
      {confirming && (
        <Modal
          title="确认修改登录账号"
          blocking
          onClose={() => {
            if (!busy) {
              setConfirming(false);
              setPassword('');
            }
          }}
        >
          <form onSubmit={save} aria-label="确认修改登录账号">
            <div className="modal-body">
              <dl className="login-policy">
                <div>
                  <dt>旧账号</dt>
                  <dd>{policy?.login}</dd>
                </div>
                <div>
                  <dt>新账号</dt>
                  <dd>{candidate}</dd>
                </div>
              </dl>
              <p className="login-change-warning">
                修改后90天内无法再次修改，原账号将无法继续登录。
              </p>
              <p className="account-muted">
                所有登录会话将失效；内部账号ID、角色及项目资料保持不变；正式展示名称单独管理。
              </p>
              <label>
                当前登录密码
                <input
                  aria-label="当前登录密码"
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={PASSWORD_MIN}
                  maxLength={PASSWORD_MAX}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setPassword('');
                }}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                确认修改并退出登录
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
