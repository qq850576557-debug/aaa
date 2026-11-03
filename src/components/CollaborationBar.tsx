import { usePresenceHeartbeat } from '../lib/usePresenceHeartbeat';
import { presenceLabel, PRESENCE_TIMEOUT, type PresenceStatus } from '../lib/presence-state';
import { OnlineCard } from './OnlineCard';
import { PersonalCard } from './PersonalCard';
import { Avatar } from './Avatar';
import { MentionInbox } from './MentionInbox';
import { useEffect, useState } from 'react';
import { cloudApi, type CloudUser } from '../lib/cloud';
export type OnlineAccount = {
  id: string;
  login: string;
  displayName: string;
  avatarVersion: string | null;
  status?: PresenceStatus;
};
export function CollaborationBar({ user, isCloud }: { user: CloudUser | null; isCloud: boolean }) {
  usePresenceHeartbeat(isCloud && !!user);
  const [selected, setSelected] = useState<OnlineAccount | null>(null);
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
    let lastRead = Date.now();
    let reading = false;
    let reread = false;
    const read = () => {
      if (reading) {
        reread = true;
        return;
      }
      reading = true;
      void cloudApi<{ accounts: OnlineAccount[] }>('/presence')
        .then((r) => {
          if (active) {
            lastRead = Date.now();
            setOnline(r.accounts);
          }
        })
        .catch(() => {
          if (active && Date.now() - lastRead > PRESENCE_TIMEOUT) setOnline([]);
        })
        .finally(() => {
          reading = false;
          if (reread && active) {
            reread = false;
            read();
          }
        });
    };
    read();
    const timer = setInterval(read, 60000);
    const foreground = () => {
      if (document.visibilityState === 'visible') read();
    };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('chunmo-presence', read);
    window.addEventListener('chunmo-profile-updated', read);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('chunmo-presence', read);
      window.removeEventListener('chunmo-profile-updated', read);
    };
  }, [isCloud]);
  return (
    <div className="collaboration-bar">
      {selected && user && (
        <OnlineCard
          account={selected}
          user={user}
          status={online.find((a) => a.id === selected.id)?.status ?? 'offline'}
          onClose={() => setSelected(null)}
        />
      )}
      {card && user && <PersonalCard user={user} onClose={() => setCard(false)} />}
      <div className="current-account" role="group" aria-label="当前登录账号">
        {user && (
          <button
            className="personal-avatar-button"
            aria-label="打开我的个人名片"
            onClick={() => setCard(true)}
          >
            <Avatar
              account={user}
              presence={online.find((a) => a.id === user.id)?.status ?? 'offline'}
            />
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
      {isCloud && user && <MentionInbox key={user.id} />}
      <div className="online-accounts" aria-label="在线协作人员">
        {online.slice(0, limit).map((a) => (
          <button
            type="button"
            className="online-member"
            data-account-id={a.id}
            key={a.id}
            title={`${a.displayName} · ${presenceLabel(a.status ?? 'busy')}`}
            aria-label={`查看${a.displayName}的在线名片`}
            onClick={() => setSelected(a)}
          >
            <Avatar
              presence={a.status ?? 'busy'}
              account={a.id === user?.id ? user : a}
              version={a.id === user?.id ? user.avatarVersion : a.avatarVersion}
            />
          </button>
        ))}
        {online.length > limit && <span className="online-more">+{online.length - limit}</span>}
        {!online.length && isCloud && <small>暂无在线连接</small>}
      </div>
    </div>
  );
}
