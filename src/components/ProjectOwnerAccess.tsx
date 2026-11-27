import { useEffect, useState } from 'react';
import { CloudError, cloudApi } from '../lib/cloud';
import { Confirm } from './Modal';
import './project-owner-access.css';

type Member = { id: string; name: string; maskedPhone: string; bound: boolean; active: boolean };
type Access = { enabled: boolean; members: Member[] };

export function ProjectOwnerAccess({
  projectId,
  onDraft,
}: {
  projectId: string;
  onDraft?: (dirty: boolean) => void;
}) {
  const url = '/projects/' + encodeURIComponent(projectId) + '/owner-access';
  const [access, setAccess] = useState<Access>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [invite, setInvite] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    run: () => Promise<void>;
  }>();
  useEffect(() => {
    let current = true;
    cloudApi<Access>(url).then(
      (response) => {
        if (current) setAccess(response);
      },
      (e) => {
        if (current && (!(e instanceof CloudError) || e.status !== 404))
          setError('业主授权读取失败');
      },
    );
    return () => {
      current = false;
    };
  }, [url]);
  useEffect(() => onDraft?.(adding && !!(name || phone)), [adding, name, phone, onDraft]);

  function resetAdd() {
    setAdding(false);
    setName('');
    setPhone('');
  }
  async function save(method: string, path: string, body?: unknown) {
    if (busy) return;
    setBusy(true);
    setError('');
    setInvite('');
    setCopied(false);
    try {
      const response = await cloudApi<{ invite?: string }>(url + path, method, body);
      if (response.invite) {
        setInvite(response.invite);
        if (path === '/members') resetAdd();
      }
      setConfirmation(undefined);
      setAccess(await cloudApi<Access>(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : '业主授权保存失败');
    } finally {
      setBusy(false);
    }
  }
  if (!access) return error ? <p role="alert">{error}</p> : null;
  return (
    <section
      className="project-owner-section owner-access"
      aria-label="业主授权"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <div className="project-owner-heading">
        <h3>业主授权</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={access.enabled}
            disabled={busy}
            onChange={({ target: { checked } }) =>
              setConfirmation({
                title: checked ? '开启本项目业主服务？' : '关闭本项目业主服务？',
                message: checked
                  ? '有效授权的业主将可以查看这个住宅的公开内容。'
                  : '本住宅将对业主隐藏，未使用邀请会失效。',
                run: () => save('PUT', '/service', { enabled: checked }),
              })
            }
          />
          开启服务
        </label>
      </div>
      <div className="owner-access-list">
        <div className="owner-access-members">
          {access.members
            .filter((member) => member.active)
            .map((member) => {
              const path = '/members/' + member.id;
              return (
                <div className="owner-access-member" key={member.id}>
                  <strong>{member.name}</strong>
                  <span>{member.maskedPhone}</span>
                  <span>{member.bound ? '已绑定' : '待绑定'}</span>
                  <div className="owner-access-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({
                          title: member.bound ? '解除业主微信绑定？' : '生成一次性邀请？',
                          message: member.bound
                            ? '此业主在所有住宅的微信会话都将失效，现有住宅授权保留。'
                            : '新口令有效期 24 小时，本住宅上一条未使用邀请将失效。',
                          run: () =>
                            save('POST', path + (member.bound ? '/unlink' : '/invite'), {}),
                        })
                      }
                    >
                      {member.bound ? '解绑' : '发邀请'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({
                          title: '撤销本住宅授权？',
                          message: '该业主将失去当前住宅的访问权限，其他住宅授权保留。',
                          run: () => save('DELETE', path, {}),
                        })
                      }
                    >
                      撤销授权
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
        {adding ? (
          <div className="owner-access-add">
            <label>
              业主姓名
              <input
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              业主手机号
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                value={phone}
                maxLength={11}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <div className="owner-access-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!name && !phone) resetAdd();
                  else
                    setConfirmation({
                      title: '放弃这位业主的填写内容？',
                      message: '已保存的授权保留。',
                      run: async () => {
                        resetAdd();
                        setConfirmation(undefined);
                      },
                    });
                }}
              >
                取消新增
              </button>
              <button
                type="button"
                disabled={busy || !name.trim() || !/^1[3-9]\d{9}$/.test(phone)}
                onClick={() =>
                  setConfirmation({
                    title: '授权并生成邀请？',
                    message: '此手机号获授权后可查看本住宅的公开内容。',
                    run: () => save('POST', '/members', { name, phone }),
                  })
                }
              >
                授权并生成邀请
              </button>
            </div>
          </div>
        ) : (
          <button className="owner-access-add-button" type="button" onClick={() => setAdding(true)}>
            ＋ 添加业主
          </button>
        )}
      </div>
      {invite && (
        <label className="form-field">
          一次性邀请口令（24 小时有效）
          <input readOnly value={invite} onFocus={(event) => event.target.select()} />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite);
                setCopied(true);
              } catch {
                setError('请选中口令后手动复制');
              }
            }}
          >
            {copied ? '已复制' : '复制邀请口令'}
          </button>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {confirmation && (
        <Confirm
          title={confirmation.title}
          message={confirmation.message}
          error={error}
          busy={busy}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => void confirmation.run()}
        />
      )}
    </section>
  );
}
