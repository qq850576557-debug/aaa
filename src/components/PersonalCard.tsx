import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { MemberCards } from './MemberCards';
import { AvatarEditor } from './AvatarEditor';
import { cloudSession, type CloudUser } from '../lib/cloud';
import { desktopV1Enabled } from '../ui-v1/mode';
export function PersonalCard({ user, onClose }: { user: CloudUser; onClose: () => void }) {
  const desktop = desktopV1Enabled();
  const [profile, setProfile] = useState(user),
    [error, setError] = useState(''),
    [aspect, setAspect] = useState(1.43),
    [actions, setActions] = useState<HTMLDivElement | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  return (
    <Modal
      title="我的个人名片"
      className="personal-card-dialog"
      onClose={onClose}
      blocking
      animateClose
      compactHeader={desktop}
      headerActions={
        desktop ? <div ref={setActions} className="personal-card-actions" /> : undefined
      }
    >
      <div className="modal-body">
        <AvatarEditor
          user={profile}
          kind="card"
          onUpdated={setProfile}
          inputRef={photoInput}
          aspect={aspect}
        />
        <MemberCards
          headerTarget={desktop ? actions : undefined}
          headerAction={
            <button
              onClick={() => {
                onClose();
                window.dispatchEvent(new Event('chunmo-open-account-settings'));
              }}
            >
              账号设置
            </button>
          }
          user={profile}
          onlyId={user.id}
          onPhotoClick={(ratio) => {
            setAspect(desktop ? 1.43 : ratio);
            const input = photoInput.current;
            if (!input) return;
            const details = input.closest('details');
            if (details) details.open = true;
            input.click();
          }}
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
        {error && <p role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
