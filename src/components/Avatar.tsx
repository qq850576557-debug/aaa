import { useState } from 'react';
export type AvatarAccount = {
  id: string;
  login: string;
  displayName?: string;
  avatarVersion?: string | null;
  cardAvatarVersion?: string | null;
};
export function Avatar({
  account,
  version,
  source,
  label,
  kind = 'system',
}: {
  account: AvatarAccount;
  version?: string | null;
  source?: string;
  label?: string;
  kind?: 'system' | 'card';
}) {
  const [failed, setFailed] = useState('');
  const imageVersion =
    version === undefined
      ? kind === 'card'
        ? account.cardAvatarVersion
        : account.avatarVersion
      : version;
  const src =
    source ||
    (imageVersion
      ? `/api/accounts/${encodeURIComponent(account.id)}/${kind === 'card' ? 'card-avatar' : 'avatar'}?v=${encodeURIComponent(imageVersion)}`
      : '');
  return (
    <span className="account-avatar" role={label ? 'img' : undefined} aria-label={label}>
      {src && failed !== src ? (
        <img src={src} alt="" onError={() => setFailed(src)} />
      ) : (
        Array.from(account.displayName || account.login)[0]
      )}
    </span>
  );
}
