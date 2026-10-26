import { useEffect, useState, type FormEvent } from 'react';
import { Modal, Confirm } from './Modal';
import { PASSWORD_MIN, PASSWORD_MAX, passwordSchema } from '../lib/password';
import { cloudApi, cloudSession, selectSpace, CloudError, type CloudUser } from '../lib/cloud';
import { AvatarEditor } from './AvatarEditor';
import { LoginNameEditor } from './LoginNameEditor';
import { loginSchema, LOGIN_HELP } from '../lib/login';
import { AuditLog } from './AuditLog';
import './account.css';
export type DirectoryAccount = {
  id: string;
  login: string;
  displayName: string;
  active: boolean;
  owner: boolean;
  note: string;
};
export function CloudControl({ isCloud, dirty }: { isCloud: boolean; dirty: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="cloud-control" onClick={() => setOpen(true)}>
        账号管理
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
    [loading, setLoading] = useState(true),
    [accounts, setAccounts] = useState<DirectoryAccount[]>([]),
    [tab, setTab] = useState('profile'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [displayName, setDisplayName] = useState(''),
    [target, setTarget] = useState(''),
    [employeeName, setEmployeeName] = useState(''),
    [note, setNote] = useState(''),
    [login, setLogin] = useState(''),
    [password, setPassword] = useState(''),
    [newName, setNewName] = useState('');
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    run: () => void;
  } | null>(null);
  const [preview, setPreview] = useState<{
    id?: string;
    revision: number;
    alreadyImported?: boolean;
    counts?: Record<string, number>;
  } | null>(null);
  const selected = accounts.find((a) => a.id === target);
  const expired = () => {
    setUser(null);
    setAccounts([]);
    setPassword('');
    setNotice('会话已失效，请重新登录。');
    window.dispatchEvent(new Event('chunmo-auth-expired'));
  };
  const report = (e: unknown) => {
    if (e instanceof CloudError && e.status === 401) expired();
    else setError(String(e));
  };
  async function directory() {
    const result = await cloudApi<{ accounts: DirectoryAccount[] }>('/directory');
    setAccounts(result.accounts);
  }
  useEffect(() => {
    let active = true;
    void Promise.all([cloudSession(), cloudApi<{ accounts: DirectoryAccount[] }>('/directory')])
      .then(([u, list]) => {
        if (active) {
          setUser(u);
          setDisplayName(u.displayName || u.login);
          setAccounts(list.accounts);
        }
      })
      .catch((e) => {
        if (active) report(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const leave = (run: () => void) => {
    if (dirty)
      setConfirmation({
        title: '离开未保存的云端草稿？',
        message: '请先取消并下载紧急备份。继续会离开当前未保存草稿，不会覆盖或清除浏览器原始数据。',
        run,
      });
    else run();
  };
  function selectAccount(id: string) {
    const a = accounts.find((a) => a.id === id);
    setTarget(id);
    setEmployeeName(a?.displayName || a?.login || '');
    setNote(a?.note || '');
    setError('');
    setNotice('');
  }
  return (
    <>
      <Modal
        title="账号管理"
        subtitle="身份、个人设置与工作室协作"
        onClose={onClose}
        wide
        className="account-dialog"
      >
        <div className="modal-body account-body">
          {loading ? (
            <p role="status">正在读取账号…</p>
          ) : !user ? (
            <div className="account-empty">
              <p role="status">{notice || '登录已失效，请重新登录。'}</p>
              <button className="primary" onClick={() => leave(() => window.location.reload())}>
                重新登录
              </button>
            </div>
          ) : (
            <>
              <div className="account-identity">
                <span className="account-avatar" aria-hidden="true">
                  {(user.displayName || user.login).slice(0, 1)}
                </span>
                <div>
                  <h3>{user.displayName || user.login}</h3>
                  <p>
                    {user.owner ? '工作室负责人' : '普通员工'} · 登录名 {user.login}
                  </p>
                </div>
              </div>
              <div className="account-tabs" role="tablist" aria-label="账号管理功能">
                {[
                  ['profile', '账号与安全'],
                  ['directory', '账号通讯录'],
                  ['audit', '操作记录'],
                  ...(user.owner ? [['import', '备份导入']] : []),
                ].map(([key, label]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => {
                      setTab(key);
                      setError('');
                      setNotice('');
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'profile' && (
                <section className="account-section" aria-label="账号与安全">
                  <form
                    aria-label="修改我的展示名称"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        await cloudApi('/auth/profile', 'PATCH', { displayName });
                        const updated = await cloudSession();
                        setUser(updated);
                        window.dispatchEvent(
                          new CustomEvent('chunmo-profile-updated', { detail: updated }),
                        );
                        await directory();
                        setNotice('展示名称已保存，登录名和账号ID保持不变。');
                      });
                    }}
                  >
                    <h3>正式展示名称</h3>
                    <p className="account-muted">可使用中文名称。操作记录会保留操作当时的名称。</p>
                    <label>
                      我的展示名称
                      <input
                        aria-label="我的展示名称"
                        required
                        maxLength={80}
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                      />
                    </label>
                    <button disabled={busy}>保存展示名称</button>
                  </form>
                  <AvatarEditor user={user} />
                  <LoginNameEditor dirty={dirty} onExpired={expired} />
                  <details className="account-card">
                    <summary>修改我的密码</summary>
                    <p className="account-muted">
                      8–128位，不限制字符组合。修改后该账号全部旧会话失效。
                    </p>
                    <PasswordForm
                      requireCurrent
                      onExpired={expired}
                      onSave={async (currentPassword, newPassword) => {
                        if (isCloud && dirty)
                          throw Error('请先保存云端草稿或下载紧急备份，再修改密码');
                        await cloudApi('/auth/password', 'POST', {
                          currentPassword,
                          newPassword,
                          confirmPassword: newPassword,
                        });
                        expired();
                        setNotice('密码已修改，全部旧会话已撤销。请使用新密码重新登录。');
                      }}
                    />
                  </details>
                  <div className="account-session-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        leave(
                          () =>
                            void action(async () => {
                              await cloudApi('/auth/logout', 'POST', {});
                              window.dispatchEvent(
                                new CustomEvent('chunmo-auth-expired', {
                                  detail: { clearWorkspace: true },
                                }),
                              );
                            }),
                        )
                      }
                    >
                      退出登录
                    </button>
                    {!isCloud && (
                      <button onClick={() => leave(() => selectSpace('cloud'))}>进入云空间</button>
                    )}
                    {isCloud && (
                      <details>
                        <summary>本地资料管理</summary>
                        <p className="account-muted">
                          本地资料独立保存，不会自动上传。切换不会删除已有资料。
                        </p>
                        <button onClick={() => leave(() => selectSpace('local'))}>
                          切换本地空间（保留账号会话）
                        </button>
                      </details>
                    )}
                  </div>
                </section>
              )}
              {tab === 'directory' && (
                <section className="account-section" aria-label="账号通讯录">
                  <p className="account-muted">
                    正式展示名称属于账号本人；“我的私有备注”仅当前账号可见。
                  </p>
                  <label>
                    选择账号
                    <select
                      aria-label="选择账号"
                      value={target}
                      onChange={(e) => selectAccount(e.target.value)}
                    >
                      <option value="">请选择账号</option>
                      {accounts
                        .filter((a) => a.id !== user.id)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName || a.login} · {a.login}
                            {a.active ? '' : '（已停用）'}
                          </option>
                        ))}
                    </select>
                  </label>
                  {selected && (
                    <div className="account-selected">
                      <h3>{selected.displayName || selected.login}</h3>
                      <p className="account-muted">
                        正式登录名：{selected.login} ·{' '}
                        {selected.owner ? '工作室负责人' : '普通员工'} ·{' '}
                        {selected.active ? '已启用' : '已停用'}
                      </p>
                      <form
                        aria-label="修改私有账号备注"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action(async () => {
                            await cloudApi(
                              '/accounts/' + encodeURIComponent(target) + '/note',
                              'PUT',
                              { note },
                            );
                            await directory();
                            setNotice('我的私有备注已保存，其他账号无法读取。');
                          });
                        }}
                      >
                        <label>
                          我的私有备注
                          <textarea
                            aria-label="我的私有备注"
                            maxLength={1000}
                            rows={3}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                          />
                        </label>
                        <button disabled={busy}>保存私有备注</button>
                      </form>
                      {user.owner && !selected.owner && (
                        <>
                          <form
                            aria-label="修改员工展示名称"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void action(async () => {
                                await cloudApi('/accounts/' + encodeURIComponent(target), 'PATCH', {
                                  displayName: employeeName,
                                });
                                await directory();
                                setNotice('员工展示名称已保存。');
                              });
                            }}
                          >
                            <label>
                              员工正式展示名称
                              <input
                                aria-label="员工正式展示名称"
                                required
                                maxLength={80}
                                value={employeeName}
                                onChange={(e) => setEmployeeName(e.target.value)}
                              />
                            </label>
                            <button disabled={busy}>保存员工展示名称</button>
                          </form>
                          <button
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: selected.active ? '停用该员工账号？' : '恢复该员工账号？',
                                message:
                                  '仅变更账号登录状态，保留关联工作记录和项目数据。停用后所有旧会话失效。',
                                run: () =>
                                  void action(async () => {
                                    await cloudApi(
                                      '/accounts/' + encodeURIComponent(target),
                                      'PATCH',
                                      { active: !selected.active },
                                    );
                                    await directory();
                                    setNotice('员工账号状态已更新。');
                                  }),
                              })
                            }
                          >
                            {selected.active ? '停用员工账号' : '恢复员工账号'}
                          </button>
                          <details className="account-card">
                            <summary>重置员工密码</summary>
                            <p className="account-muted">
                              无需原密码。重置后员工全部旧会话失效，角色、状态和工作记录保持不变。
                            </p>
                            <PasswordForm
                              key={target}
                              requireCurrent={false}
                              onExpired={expired}
                              onSave={async (_current, password) => {
                                await cloudApi('/accounts/' + encodeURIComponent(target), 'PATCH', {
                                  password,
                                });
                                setNotice('员工密码已重置，全部旧会话已撤销，请通知员工重新登录。');
                              }}
                            />
                          </details>
                        </>
                      )}
                    </div>
                  )}
                  {user.owner && (
                    <details className="account-card">
                      <summary>创建普通员工账号</summary>
                      <p className="account-muted">{LOGIN_HELP}</p>
                      <form
                        aria-label="创建普通员工账号"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const account = loginSchema.safeParse(login);
                          if (!account.success) {
                            setError(account.error.issues[0].message);
                            return;
                          }
                          const checked = passwordSchema.safeParse(password);
                          if (!checked.success) {
                            setError(checked.error.issues[0].message);
                            return;
                          }
                          void action(async () => {
                            await cloudApi('/accounts', 'POST', {
                              login: account.data,
                              password,
                              ...(newName.trim() ? { displayName: newName } : {}),
                            });
                            setPassword('');
                            setLogin('');
                            setNewName('');
                            await directory();
                            setNotice('普通员工账号已创建。');
                          });
                        }}
                      >
                        <label>
                          新员工登录名
                          <input
                            aria-label="新员工登录名"
                            autoComplete="off"
                            required
                            minLength={3}
                            maxLength={160}
                            value={login}
                            onChange={(e) => setLogin(e.target.value)}
                          />
                        </label>
                        <label>
                          员工展示名称
                          <input
                            aria-label="员工展示名称"
                            maxLength={80}
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                          />
                        </label>
                        <label>
                          初始密码
                          <input
                            aria-label="初始密码"
                            type="password"
                            autoComplete="new-password"
                            required
                            minLength={PASSWORD_MIN}
                            maxLength={PASSWORD_MAX}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                          />
                        </label>
                        <button disabled={busy}>创建员工</button>
                      </form>
                    </details>
                  )}
                </section>
              )}
              {tab === 'audit' && <AuditLog accounts={accounts} />}
              {tab === 'import' && user.owner && (
                <section className="account-section">
                  <h3>导入本地业务与版本备份</h3>
                  <p className="account-muted">
                    只合并无冲突的稳定ID；同ID不同内容拒绝，不覆盖已有记录。原浏览器资料保留。
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
                      await action(async () => {
                        if (file.size > 16 * 1024 * 1024)
                          throw Error('备份超过16MiB，请先分批整理');
                        setPreview(
                          await cloudApi('/import/preview', 'POST', {
                            archive: JSON.parse(await file.text()),
                          }),
                        );
                      });
                      e.target.value = '';
                    }}
                  />
                  {preview &&
                    (preview.alreadyImported ? (
                      <p>此备份已导入，不会重复创建。</p>
                    ) : (
                      <>
                        <p>校验预览：{JSON.stringify(preview.counts)}</p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              title: '导入到云工作空间？',
                              message:
                                '预览的无冲突业务将合并并记录真实操作账号。他人修改后须重新预览，原浏览器资料保留。',
                              run: () =>
                                void action(async () => {
                                  await cloudApi('/import/commit', 'POST', {
                                    id: preview.id,
                                    revision: preview.revision,
                                    confirm: true,
                                  });
                                  setPreview(null);
                                  setNotice('导入成功，云空间将自动刷新。');
                                }),
                            })
                          }
                        >
                          确认导入预览
                        </button>
                      </>
                    ))}
                </section>
              )}
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && user && (
            <p className="account-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <footer className="modal-foot">
          <button onClick={onClose}>关闭</button>
        </footer>
      </Modal>
      {confirmation && (
        <Confirm
          title={confirmation.title}
          message={confirmation.message}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const run = confirmation.run;
            setConfirmation(null);
            run();
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
  onSave: (current: string, next: string) => Promise<void>;
  onExpired: () => void;
}) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      aria-label={requireCurrent ? '修改我的密码' : '重置员工密码'}
      onSubmit={async (e: FormEvent) => {
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
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {requireCurrent ? '保存我的新密码' : '重置员工密码'}
      </button>
    </form>
  );
}
