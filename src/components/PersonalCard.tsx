import { useState } from 'react';
import { Modal } from './Modal';
import { MemberCards } from './MemberCards';
import { AvatarEditor } from './AvatarEditor';
import { cloudSession, type CloudUser } from '../lib/cloud';
export function PersonalCard({ user, onClose }: { user: CloudUser; onClose: () => void }) {
  const [profile, setProfile] = useState(user),
    [error, setError] = useState('');
  return (
    <Modal title="我的个人名片" className="personal-card-dialog" onClose={onClose}>
      <div className="modal-body">
        <div className="personal-settings">
          <button
            onClick={() => {
              onClose();
              window.dispatchEvent(new Event('chunmo-open-account-settings'));
            }}
          >
            账号设置
          </button>
        </div>
        <MemberCards
          user={profile}
          onlyId={user.id}
          onSaved={async () => {
            try {
              const fresh = await cloudSession();
              setProfile(fresh);
              window.dispatchEvent(new CustomEvent('chunmo-profile-updated', { detail: fresh }));
            } catch (e) {
              setError(String(e));
            }
          }}
        />
        <AvatarEditor user={profile} kind="card" onUpdated={setProfile} />
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="modal-foot">
        <button onClick={onClose}>关闭</button>
      </footer>
    </Modal>
  );
}
