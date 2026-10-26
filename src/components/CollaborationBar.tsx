import { useEffect, useState } from 'react';
import { cloudApi, type CloudUser } from '../lib/cloud';
export type OnlineAccount = {
  id: string;
  login: string;
  displayName: string;
  avatarVersion: string | null;
};
export function Avatar({
  account,
  version,
}: {
  account: { id: string; displayName?: string; login: string };
  version?: string | null;
}) {
  return (
    <span className="account-avatar">
      {version ? (
        <img
          src={`/api/accounts/${encodeURIComponent(account.id)}/avatar?v=${encodeURIComponent(version)}`}
          alt=""
        />
      ) : (
        Array.from(account.displayName || account.login)[0]
      )}
    </span>
  );
}
export function CollaborationBar({ user, isCloud }: { user: CloudUser | null; isCloud: boolean }) {
  const [online, setOnline] = useState<OnlineAccount[]>([]);
  const [limit, setLimit] = useState(() => (matchMedia('(max-width:950px)').matches ? 2 : 5));
  useEffect(() => {
    const media = matchMedia('(max-width:950px)');
    const change = () => setLimit(media.matches ? 2 : 5);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!isCloud) return;
    let active = true;
    const read = () => {
      void cloudApi<{ accounts: OnlineAccount[] }>('/presence')
        .then((r) => {
          if (active) setOnline(r.accounts);
        })
        .catch(() => {
          if (active) setOnline([]);
        });
    };
    read();
    const timer = setInterval(read, 10000);
    window.addEventListener('chunmo-presence', read);
    window.addEventListener('chunmo-profile-updated', read);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('chunmo-presence', read);
      window.removeEventListener('chunmo-profile-updated', read);
    };
  }, [isCloud]);
  return (
    <div className="collaboration-bar">
      <div className="current-account">
        {user && (
          <Avatar account={user} version={online.find((a) => a.id === user.id)?.avatarVersion} />
        )}
        <strong title={user?.login}>{user?.displayName || user?.login || '本地工作空间'}</strong>
      </div>
      <div className="online-accounts" aria-label="在线协作人员">
        {online.slice(0, limit).map((a) => (
          <span className="online-member" key={a.id} title={`${a.displayName} · 在线`}>
            <Avatar account={a} version={a.avatarVersion} />
          </span>
        ))}
        {online.length > limit && <span className="online-more">+{online.length - limit}</span>}
        {!online.length && isCloud && <small>暂无在线连接</small>}
      </div>
    </div>
  );
}
