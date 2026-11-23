import { useEffect, useState } from 'react';
import { CloudError, cloudApi } from '../lib/cloud';
import './project-owner-access.css';

type Member = { id: string; name: string; maskedPhone: string; bound: boolean; active: boolean };
type Access = { enabled: boolean; members: Member[] };

export function ProjectOwnerAccess({ projectId }: { projectId: string }) {
  const url = '/projects/' + encodeURIComponent(projectId) + '/owner-access';
  const [access, setAccess] = useState<Access>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [invite, setInvite] = useState('');
  const [copied, setCopied] = useState(false);
  const [rebind, setRebind] = useState<Member>();
  useEffect(() => {
    let current = true;
    cloudApi<Access>(url).then(
      (response) => {
        if (current) setAccess(response);
      },
      (e) => {
        if (current && (!(e instanceof CloudError) || e.status !== 404))
          setError(e instanceof Error ? e.message : '业主授权读取失败');
      },
    );
    return () => {
      current = false;
    };
  }, [url]);
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
        setName('');
        setPhone('');
        setRebind(undefined);
      }
      setAccess(await cloudApi<Access>(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : '业主授权保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
    } catch {
      setError('请选中口令后手动复制');
    }
  }
  if (!access) return error ? <p role="alert">{error}</p> : null;
  return (
    <details
      className="form-field owner-access"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <summary>业主授权</summary>
      <div className="form-grid">
        <label className="check span2">
          <input
            type="checkbox"
            checked={access.enabled}
            disabled={busy}
            onChange={(event) => void save('PUT', '/service', { enabled: event.target.checked })}
          />
          开启本项目业主采购服务
        </label>
        <label className="form-field">
          业主称呼
          <input
            value={name}
            maxLength={60}
            disabled={busy || Boolean(rebind)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field">
          {rebind ? '更换手机号（留空沿用）' : '业主手机号'}
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            value={phone}
            maxLength={11}
            disabled={busy}
            onChange={(event) => setPhone(event.target.value)}
          />
        </label>
        {rebind ? (
          <div className="span2">
            <p>重新绑定「{rebind.name}」将清除该成员现有微信绑定和业主会话。</p>
            <button
              type="button"
              disabled={busy || (!!phone && !/^1[3-9]\d{9}$/.test(phone))}
              onClick={() =>
                void save('POST', '/members/' + rebind.id + '/rebind', phone ? { phone } : {})
              }
            >
              确认重新绑定
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRebind(undefined);
                setPhone('');
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="span2"
            disabled={busy || !name.trim() || !/^1[3-9]\d{9}$/.test(phone)}
            onClick={() => void save('POST', '/members', { name, phone })}
          >
            授权并生成邀请
          </button>
        )}
        {access.members.map((member) => (
          <div className="span2 owner-access-member" key={member.id}>
            <span>
              {member.name} · {member.maskedPhone} ·{' '}
              {member.active ? (member.bound ? '已绑定' : '待绑定') : '已撤销'}
            </span>
            {member.active && (
              <div className="owner-access-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPhone('');
                    setRebind(member);
                  }}
                >
                  重新绑定
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save('DELETE', '/members/' + member.id, {})}
                >
                  撤销本项目授权
                </button>
              </div>
            )}
          </div>
        ))}
        {invite && (
          <div className="form-field span2">
            <label>
              一次性邀请口令（24 小时有效）
              <input readOnly value={invite} onFocus={(event) => event.target.select()} />
            </label>
            <button type="button" onClick={() => void copyInvite()}>
              {copied ? '已复制邀请口令' : '复制邀请口令'}
            </button>
            <label>
              开发工具邀请路径
              <input
                readOnly
                value={'owner-login/pages/welcome/index?invite=' + invite}
                onFocus={(event) => event.target.select()}
              />
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="span2">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
