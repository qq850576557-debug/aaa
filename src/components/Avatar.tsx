import { useState } from 'react';
export type AvatarAccount = {
  id: string;
  login: string;
  displayName?: string;
  avatarVersion?: string | null;
};
export function Avatar({
  account,
  version,
  source,
  label,
}: {
  account: AvatarAccount;
  version?: string | null;
  source?: string;
  label?: string;
}) {
  const [failed, setFailed] = useState('');
  const imageVersion = version === undefined ? account.avatarVersion : version;
  const src =
    source ||
    (imageVersion
      ? `/api/accounts/${encodeURIComponent(account.id)}/avatar?v=${encodeURIComponent(imageVersion)}`
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
