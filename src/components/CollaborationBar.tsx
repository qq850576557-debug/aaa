import { PersonalCard } from './PersonalCard';
import { Avatar } from './Avatar';
import { useEffect, useState } from 'react';
import { cloudApi, type CloudUser } from '../lib/cloud';
export type OnlineAccount = {
  id: string;
  login: string;
  displayName: string;
  avatarVersion: string | null;
};
export function CollaborationBar({ user, isCloud }: { user: CloudUser | null; isCloud: boolean }) {
  const [card, setCard] = useState(false);
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
      {card && user && <PersonalCard user={user} onClose={() => setCard(false)} />}
      <div className="current-account" role="group" aria-label="当前登录账号">
        {user && (
          <button
            className="personal-avatar-button"
            aria-label="打开我的个人名片"
            onClick={() => setCard(true)}
          >
            <Avatar account={user} />
          </button>
        )}
        {user ? (
          <button
            className="personal-name-button"
            title={user.login}
            aria-label="点击姓名打开我的个人名片"
            onClick={() => setCard(true)}
          >
            <strong>{user.displayName || user.login}</strong>
          </button>
        ) : (
          <strong>本地工作空间</strong>
        )}
      </div>
      <div className="online-accounts" aria-label="在线协作人员">
        {online.slice(0, limit).map((a) => (
          <span className="online-member" key={a.id} title={`${a.displayName} · 在线`}>
            <Avatar
              account={a.id === user?.id ? user : a}
              version={a.id === user?.id ? user.avatarVersion : a.avatarVersion}
            />
          </span>
        ))}
        {online.length > limit && <span className="online-more">+{online.length - limit}</span>}
        {!online.length && isCloud && <small>暂无在线连接</small>}
      </div>
    </div>
  );
}
