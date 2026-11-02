import { Modal } from './Modal';
import { MemberCards } from './MemberCards';
import { PersonalCard } from './PersonalCard';
import type { CloudUser } from '../lib/cloud';
import type { OnlineAccount } from './CollaborationBar';
import './photo-editor.css';
export function OnlineCard({
  account,
  user,
  online,
  onClose,
}: {
  account: OnlineAccount;
  user: CloudUser;
  online: boolean;
  onClose: () => void;
}) {
  if (account.id === user.id) return <PersonalCard user={user} onClose={onClose} />;
  return (
    <Modal
      title="在线人员名片"
      className="personal-card-dialog"
      onClose={onClose}
      blocking
      animateClose
    >
      <div className="modal-body">
        <MemberCards
          user={user}
          onlyId={account.id}
          readOnly
          onlineStatus={online}
          onSaved={async () => {}}
        />
      </div>
    </Modal>
  );
}
