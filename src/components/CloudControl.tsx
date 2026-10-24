import { useState, type FormEvent } from 'react';
import { Modal, Confirm } from './Modal';
import { cloudApi, cloudSession, selectSpace, type CloudUser } from '../lib/cloud';
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
  const [preview, setPreview] = useState<{
      id?: string;
      revision: number;
      alreadyImported?: boolean;
      counts?: Record<string, number>;
    } | null>(null),
    [confirm, setConfirm] = useState(false),
    [leave, setLeave] = useState<(() => void) | null>(null);
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
    setBusy(true);
    setError('');
    try {
      await cloudApi('/auth/login', 'POST', { login, password });
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
                    minLength={12}
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
              {user.owner && (
                <>
                  <details>
                    <summary>创建普通员工账号</summary>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
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
                          minLength={12}
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </label>
                      <button disabled={busy}>创建员工</button>
                    </form>
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
