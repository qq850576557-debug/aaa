import { useState, type FormEvent } from 'react';
import { Modal, Confirm } from './Modal';
import { PASSWORD_MIN, PASSWORD_MAX, passwordSchema } from '../lib/password';
import { cloudApi, cloudSession, selectSpace, CloudError, type CloudUser } from '../lib/cloud';
export function CloudControl({ isCloud, dirty }: { isCloud: boolean; dirty: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="cloud-control" onClick={() => setOpen(true)}>
        {isCloud ? '云端账号' : '连接云空间'}
      </button>
      {open && <CloudPanel isCloud={isCloud} dirty={dirty} onClose={() => setOpen(false)} />}
    </>
  );
}
function CloudPanel({
  isCloud,
  dirty,
  onClose,
}: {
  isCloud: boolean;
  dirty: boolean;
  onClose: () => void;
}) {
  const [user, setUser] = useState<CloudUser | null>(null),
    [login, setLogin] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [accounts, setAccounts] = useState<{ id: string; login: string; active: boolean }[]>([]),
    [target, setTarget] = useState('');
  const [preview, setPreview] = useState<{
      id?: string;
      revision: number;
      alreadyImported?: boolean;
      counts?: Record<string, number>;
    } | null>(null),
    [confirm, setConfirm] = useState(false),
    [leave, setLeave] = useState<(() => void) | null>(null);
  const expired = () => {
    setLogin(user?.login ?? login);
    setUser(null);
    setPassword('');
    setAccounts([]);
    setTarget('');
    setNotice('会话已失效，请重新登录。');
  };
  const load = async () => {
    try {
      setUser(await cloudSession());
    } catch (e) {
      setError(String(e));
    }
  };
  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (isCloud && dirty) {
      setError('请先备份草稿并处理保存状态，再切换账号');
      return;
    }
    const checked = passwordSchema.safeParse(password);
    if (!checked.success) {
      setError(checked.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await cloudApi('/auth/login', 'POST', { login, password });
      setNotice('');
      setPassword('');
      setUser(await cloudSession());
      if (isCloud) selectSpace('cloud');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const enter = () => (dirty ? setLeave(() => () => selectSpace('cloud')) : selectSpace('cloud'));
  return (
    <>
      <Modal title="云端账号与工作空间" onClose={onClose}>
        <div className="modal-body">
          <p>
            本地与云空间独立。登录不会上传或清空IndexedDB。仅在明确选择进入云空间后使用服务端数据。
          </p>
          {!user ? (
            <>
              <button onClick={() => void load()}>检查现有云端会话</button>
              <form onSubmit={signIn}>
                <label>
                  登录账号
                  <input
                    aria-label="登录账号"
                    autoComplete="username"
                    required
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                  />
                </label>
                <label>
                  登录密码
                  <input
                    aria-label="登录密码"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={PASSWORD_MIN}
                    maxLength={PASSWORD_MAX}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <button disabled={busy} className="primary">
                  登录云端
                </button>
              </form>
            </>
          ) : (
            <>
              <p>
                {user.login} · {user.owner ? '工作室负责人' : '普通员工'} · 工作室公共业务协作权限
              </p>
              <button onClick={enter} disabled={busy}>
                进入云空间
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  const logout = async () => {
                    setBusy(true);
                    try {
                      await cloudApi('/auth/logout', 'POST', {});
                      selectSpace('local');
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  };
                  if (dirty) setLeave(() => () => void logout());
                  else void logout();
                }}
              >
                退出登录并返回本地
              </button>
              <details>
                <summary>修改我的密码</summary>
                <p>密码8–128位，不限制字符组合。成功后该账号所有会话失效，须重新登录。</p>
                <PasswordForm
                  requireCurrent
                  onExpired={expired}
                  onSave={async (currentPassword, newPassword) => {
                    if (isCloud && dirty) throw Error('请先保存云端草稿或下载紧急备份，再修改密码');
                    await cloudApi('/auth/password', 'POST', {
                      currentPassword,
                      newPassword,
                      confirmPassword: newPassword,
                    });
                    setLogin(user.login);
                    setUser(null);
                    setPassword('');
                    setAccounts([]);
                    setTarget('');
                    setError('');
                    setNotice('密码已修改，全部旧会话已撤销。请使用新密码重新登录。');
                  }}
                />
              </details>
              {user.owner && (
                <>
                  <details>
                    <summary>创建普通员工账号</summary>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const checked = passwordSchema.safeParse(password);
                        if (!checked.success) {
                          setError(checked.error.issues[0].message);
                          return;
                        }
                        setError('');
                        setBusy(true);
                        try {
                          await cloudApi('/accounts', 'POST', { login, password });
                          setPassword('');
                          setNotice('普通员工账号已创建。');
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <label>
                        新员工登录名
                        <input
                          aria-label="新员工登录名"
                          required
                          value={login}
                          onChange={(e) => setLogin(e.target.value)}
                        />
                      </label>
                      <label>
                        初始密码
                        <input
                          aria-label="初始密码"
                          type="password"
                          autoComplete="new-password"
                          minLength={PASSWORD_MIN}
                          maxLength={PASSWORD_MAX}
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </label>
                      <button disabled={busy}>创建员工</button>
                    </form>
                  </details>
                  <details>
                    <summary>员工账号管理</summary>
                    <p>
                      负责人可重置员工密码，无需原密码。员工所有会话将失效，角色、状态和业务记录保持不变。
                    </p>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          const result = await cloudApi<{ accounts: typeof accounts }>('/accounts');
                          setAccounts(result.accounts);
                          setTarget('');
                          if (!result.accounts.length) setNotice('暂无员工账号');
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      加载员工账号
                    </button>
                    <label>
                      选择员工账号
                      <select
                        aria-label="选择员工账号"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                      >
                        <option value="">请选择员工</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.login}
                            {a.active ? '' : '（已停用）'}
                          </option>
                        ))}
                      </select>
                    </label>
                    {target && (
                      <PasswordForm
                        key={target}
                        requireCurrent={false}
                        onExpired={expired}
                        onSave={async (_current, password) => {
                          await cloudApi('/accounts/' + encodeURIComponent(target), 'PATCH', {
                            password,
                          });
                          setError('');
                          setNotice('员工密码已重置，全部旧会话已撤销，请通知员工重新登录。');
                        }}
                      />
                    )}
                  </details>
                  <details>
                    <summary>导入本地业务与版本备份</summary>
                    <p>
                      先在本地空间下载完整备份，再选择文件预览。只合并无冲突的稳定ID；同ID不同内容会拒绝，不覆盖云端已有记录。
                    </p>
                    <input
                      aria-label="选择云端导入备份"
                      type="file"
                      accept="application/json,.json"
                      disabled={busy}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setPreview(null);
                        setBusy(true);
                        setError('');
                        try {
                          if (file.size > 16 * 1024 * 1024)
                            throw Error('备份超过16MiB，请先分批整理');
                          const value = await cloudApi<NonNullable<typeof preview>>(
                            '/import/preview',
                            'POST',
                            { archive: JSON.parse(await file.text()) },
                          );
                          setPreview(value);
                        } catch (err) {
                          setError(String(err));
                        } finally {
                          setBusy(false);
                          e.target.value = '';
                        }
                      }}
                    />
                    {preview &&
                      (preview.alreadyImported ? (
                        <p>此备份已导入，不会重复创建。</p>
                      ) : (
                        <>
                          <p>校验预览：{JSON.stringify(preview.counts)}</p>
                          <button disabled={busy} onClick={() => setConfirm(true)}>
                            确认导入预览
                          </button>
                        </>
                      ))}
                  </details>
                </>
              )}
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
        <footer className="modal-foot">
          {isCloud && (
            <button
              onClick={() => {
                if (dirty) setLeave(() => () => selectSpace('local'));
                else selectSpace('local');
              }}
            >
              切换本地空间（保留账号会话）
            </button>
          )}
          <button onClick={onClose}>关闭</button>
        </footer>
      </Modal>
      {leave && (
        <Confirm
          title="离开未保存的云端草稿？"
          message="请先关闭此提示并下载紧急备份。继续会丢弃当前页面未保存草稿；不会覆盖或清除本地IndexedDB。"
          onCancel={() => setLeave(null)}
          onConfirm={leave}
        />
      )}
      {confirm && preview && (
        <Confirm
          title="导入到云工作空间？"
          message="已预览的备份将与云端无冲突数据合并并记录真实操作账号。仅本次预览版本有效；他人修改后需要重新预览。本地原始数据不会删除。"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            setBusy(true);
            void cloudApi('/import/commit', 'POST', {
              id: preview.id,
              revision: preview.revision,
              confirm: true,
            })
              .then(() => {
                setPreview(null);
                setNotice('导入成功；可进入云空间或等待实时刷新。');
              })
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </>
  );
}

function PasswordForm({
  requireCurrent,
  onSave,
  onExpired,
}: {
  requireCurrent: boolean;
  onExpired: () => void;
  onSave: (current: string, next: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      aria-label={requireCurrent ? '修改我的密码' : '重置员工密码'}
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        for (const value of [next, ...(requireCurrent ? [current] : [])]) {
          const result = passwordSchema.safeParse(value);
          if (!result.success) {
            setError(result.error.issues[0].message);
            return;
          }
        }
        if (next !== confirmation) {
          setError('两次输入的新密码不一致');
          return;
        }
        setBusy(true);
        try {
          await onSave(current, next);
          setCurrent('');
          setNext('');
          setConfirmation('');
        } catch (e) {
          if (e instanceof CloudError && e.status === 401) onExpired();
          else setError(String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {requireCurrent && (
        <label>
          当前密码
          <input
            aria-label="当前密码"
            type="password"
            autoComplete="current-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
      )}
      <label>
        新密码
        <input
          aria-label="新密码"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label>
        确认新密码
        <input
          aria-label="确认新密码"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {requireCurrent ? '保存我的新密码' : '重置员工密码'}
      </button>
    </form>
  );
}
