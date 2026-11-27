import { createPortal } from 'react-dom';
import { AccountDirectory } from './AccountDirectory';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Modal, Confirm } from './Modal';
import { PASSWORD_MIN, PASSWORD_MAX, passwordSchema } from '../lib/password';
import { cloudApi, cloudSession, selectSpace, CloudError, type CloudUser } from '../lib/cloud';
import { Avatar } from './Avatar';
import { accountPermissions } from '../lib/account-permissions';
import { AvatarEditor } from './AvatarEditor';
import { LoginNameEditor } from './LoginNameEditor';
import { AuditLog } from './AuditLog';
import './account.css';
export type DirectoryAccount = {
  id: string;
  login: string;
  displayName: string;
  active: boolean;
  owner: boolean;
  note: string;
  avatarVersion?: string | null;
};
export function CloudControl({
  isCloud,
  dirty,
  initialUser,
}: {
  isCloud: boolean;
  dirty: boolean;
  initialUser?: CloudUser | null;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const openSettings = () => setOpen(true);
    window.addEventListener('chunmo-open-account-settings', openSettings);
    return () => window.removeEventListener('chunmo-open-account-settings', openSettings);
  }, []);
  return (
    <>
      <button className="cloud-control" onClick={() => setOpen(true)}>
        账号管理
      </button>
      {open && (
        <CloudPanel
          isCloud={isCloud}
          dirty={dirty}
          initialUser={initialUser}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
const accountTabs = [
  ['accounts', '账号管理'],
  ['profile', '个人中心'],
  ['audit', '操作记录'],
  ['import', '备份导入'],
] as const;
const accountCategories = [
  ['staff', '员工账号'],
  ['owner', '业主账号'],
] as const;

function CloudPanel({
  isCloud,
  dirty,
  onClose,
  initialUser,
}: {
  isCloud: boolean;
  dirty: boolean;
  onClose: () => void;
  initialUser?: CloudUser | null;
}) {
  const id = useId();
  const profileTouched = useRef(false),
    sessionCheck = useRef<Promise<void>>(Promise.resolve());
  const [user, setUser] = useState<CloudUser | null>(initialUser ?? null),
    [loading, setLoading] = useState(!initialUser),
    [accounts, setAccounts] = useState<DirectoryAccount[]>([]),
    [tab, setTab] = useState<(typeof accountTabs)[number][0]>('accounts'),
    [category, setCategory] = useState<(typeof accountCategories)[number][0]>('staff'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [displayName, setDisplayName] = useState(initialUser?.displayName || initialUser?.login || '');
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
  const expired = () => {
    setUser(null);
    setAccounts([]);
    setNotice('会话已失效，请重新登录。');
    window.dispatchEvent(new Event('chunmo-auth-expired'));
  };
  const report = (e: unknown) => {
    if (e instanceof CloudError && e.status === 401) expired();
    else setError(String(e));
  };
  useEffect(() => {
    const refreshProfile = () => {
      if (!user || document.visibilityState !== 'visible') return;
      void cloudSession()
        .then((next) => {
          if (next.id === user.id) setUser(next);
        })
        .catch(() => {});
    };
    window.addEventListener('focus', refreshProfile);
    document.addEventListener('visibilitychange', refreshProfile);
    return () => {
      window.removeEventListener('focus', refreshProfile);
      document.removeEventListener('visibilitychange', refreshProfile);
    };
  }, [user?.id]);
  async function directory() {
    const result = await cloudApi<{ accounts: DirectoryAccount[] }>('/directory');
    setAccounts(result.accounts);
  }
  useEffect(() => {
    let active = true;
    const checking = cloudSession().then((u) => {
      if (initialUser && u.id !== initialUser.id)
        throw new CloudError(401, '登录账号已变化，请重新登录；原账号草稿已保留');
      if (active) {
        setUser(u);
        if (!profileTouched.current) setDisplayName(u.displayName || u.login);
      }
    });
    sessionCheck.current = checking;
    void checking
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
  useEffect(() => {
    if (user && tab === 'audit' && accountPermissions(user.owner).directory)
      void directory().catch(report);
  }, [user?.id, tab]);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await sessionCheck.current;
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
  return createPortal(
    <>
      <Modal title="账号管理" onClose={onClose} wide className="account-dialog">
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
              <div className="account-tabs" role="tablist" aria-label="账号管理功能">
                {accountTabs
                  .filter(([key]) => key === 'accounts' || key === 'profile')
                  .map(([key, label]) => (
                    <button
                      key={key}
                      id={id + '-' + key}
                      role="tab"
                      aria-controls={id + '-panel'}
                      aria-selected={tab === key}
                      onClick={() => {
                        if (tab === key) return;
                        setTab(key);
                        setError('');
                        setNotice('');
                      }}
                    >
                      {label}
                    </button>
                  ))}
              </div>
              <div
                key={tab}
                id={id + '-panel'}
                role="tabpanel"
                aria-labelledby={id + '-' + tab}
                className={
                  tab === 'accounts'
                    ? 'account-tab-content account-list-panel'
                    : 'account-tab-content'
                }
              >
                {tab === 'profile' && (
                  <section className="account-section" aria-label="个人中心">
                    <div className="account-identity">
                      <Avatar account={user} />
                      <div>
                        <h3>{user.displayName || user.login}</h3>
                        <p>
                          {user.owner ? '工作室负责人' : '普通员工'} · 登录名 {user.login}
                        </p>
                      </div>
                    </div>
                    <form
                      aria-label="修改我的展示名称"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!profileTouched.current) {
                          setNotice('没有需要保存的名称修改。');
                          return;
                        }
                        void action(async () => {
                          await cloudApi('/auth/profile', 'PATCH', { displayName });
                          const updated = await cloudSession();
                          setUser(updated);
                          profileTouched.current = false;
                          window.dispatchEvent(
                            new CustomEvent('chunmo-profile-updated', { detail: updated }),
                          );
                          await directory();
                          setNotice('展示名称已保存，登录名和账号ID保持不变。');
                        });
                      }}
                    >
                      <label>
                        我的展示名称
                        <input
                          aria-label="我的展示名称"
                          required
                          maxLength={80}
                          value={displayName}
                          disabled={busy}
                          onChange={(e) => {
                            profileTouched.current = true;
                            setDisplayName(e.target.value);
                          }}
                        />
                      </label>
                      <button disabled={busy}>保存展示名称</button>
                    </form>
                    <AvatarEditor user={user} onUpdated={setUser} />
                    <PersonalWechatStatus key={user.id} />
                    {accountPermissions(user.owner).changeLogin && (
                      <LoginNameEditor dirty={dirty} onExpired={expired} />
                    )}
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
                        <button onClick={() => leave(() => selectSpace('cloud'))}>
                          进入云空间
                        </button>
                      )}
                    </div>
                  </section>
                )}
                {tab === 'accounts' && (
                  <>
                    <div className="account-segments" role="tablist" aria-label="账号分类">
                      {accountCategories
                        .filter(([key]) => key === 'staff' || user.owner)
                        .map(([key, label]) => (
                          <button
                            key={key}
                            id={id + '-' + key}
                            role="tab"
                            aria-controls={id + '-directory'}
                            aria-selected={category === key}
                            onClick={() => setCategory(key)}
                          >
                            {label}
                          </button>
                        ))}
                    </div>
                    <div
                      key={category}
                      id={id + '-directory'}
                      role="tabpanel"
                      aria-labelledby={id + '-' + category}
                      className="account-directory-panel"
                    >
                      <AccountDirectory
                        category={category}
                        user={user}
                        onProfile={async (card) => {
                          if (card.id === user.id) {
                            const updated = await cloudSession();
                            setUser(updated);
                            setDisplayName(updated.displayName || updated.login);
                            window.dispatchEvent(
                              new CustomEvent('chunmo-profile-updated', { detail: updated }),
                            );
                          }
                        }}
                      />
                    </div>
                  </>
                )}
                {tab === 'audit' && accountPermissions(user.owner).audit && (
                  <AuditLog accounts={accounts} />
                )}
                {tab === 'import' && accountPermissions(user.owner).backupImport && (
                  <section className="account-section">
                    <h3>导入本地业务与版本备份</h3>
                    <p className="account-muted">
                      只合并无冲突的稳定ID；同ID不同内容拒绝，不覆盖已有记录。原浏览器资料保留。材料台账、人员考核、名片、入职日期与账号授权由独立服务端记录保存，不在项目
                      JSON 范围内；完整恢复需服务器加密数据库备份。
                    </p>
                    {isCloud && (
                      <div className="local-backup-access">
                        <button onClick={() => leave(() => selectSpace('local'))}>
                          切换本地空间（保留账号会话）
                        </button>
                      </div>
                    )}
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
              </div>
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
    </>,
    document.body,
  );
}
function PersonalWechatStatus() {
  const [binding, setBinding] = useState<{ phoneSuffix?: string | null; bound: boolean }>();
  const [unavailable, setUnavailable] = useState('');
  useEffect(() => {
    let active = true;
    cloudApi<{ phoneSuffix?: string | null; bound: boolean }>('/auth/wechat-binding').then(
      (value) => {
        if (active) setBinding(value);
      },
      (error) => {
        if (active)
          setUnavailable(
            error instanceof CloudError && error.status === 404 ? '暂未开放' : '读取失败',
          );
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <dl className="account-personal-binding">
      <div>
        <dt>手机号</dt>
        <dd>
          {unavailable ||
            (!binding
              ? '读取中…'
              : binding.phoneSuffix
                ? '•••••••' + binding.phoneSuffix
                : '未绑定')}
        </dd>
      </div>
      <div>
        <dt>微信绑定</dt>
        <dd>{unavailable || (!binding ? '读取中…' : binding.bound ? '已绑定' : '待绑定')}</dd>
      </div>
    </dl>
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
