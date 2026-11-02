import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import { cloudApi } from '../lib/cloud';
import type { MemberCard } from '../lib/member-cards';
import type { OnlineAccount } from './CollaborationBar';
export function OnlineCard({
  account,
  online,
  onClose,
}: {
  account: OnlineAccount;
  online: boolean;
  onClose: () => void;
}) {
  const [card, setCard] = useState<MemberCard>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void cloudApi<{ cards: MemberCard[] }>('/member-cards')
      .then((r) => {
        if (active) setCard(r.cards.find((c) => c.id === account.id));
      })
      .catch(() => {
        if (active) setError('岗位暂时无法读取');
      });
    return () => {
      active = false;
    };
  }, [account.id]);
  return (
    <Modal title="在线人员名片" onClose={onClose}>
      <div className="modal-body online-card">
        <Avatar account={card ?? account} />
        <h2>{card?.displayName || account.displayName}</h2>
        <p>{card?.jobTitle || card?.departmentName || (card?.owner ? '负责人' : '岗位未设置')}</p>
        <p>{online ? '● 在线' : '○ 离线'}</p>
        {error && <p role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
