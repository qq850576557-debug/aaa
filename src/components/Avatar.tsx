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
  showStatus = false,
}: {
  account: AvatarAccount;
  version?: string | null;
  source?: string;
  label?: string;
  kind?: 'system' | 'card';
  showStatus?: boolean;
}) {
  const [failed, setFailed] = useState('');
  const [loaded, setLoaded] = useState({ src: '', width: 0, height: 0 });
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
    <span
      className="account-avatar"
      role={label ? 'img' : undefined}
      aria-label={label}
      data-image-state={
        !src ? 'empty' : failed === src ? 'failed' : loaded.src === src ? 'loaded' : 'loading'
      }
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          decoding="async"
          onLoad={(e) =>
            setLoaded({
              src,
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(src)}
        />
      ) : (
        Array.from(account.displayName || account.login)[0]
      )}
      {showStatus && src && loaded.src !== src && failed !== src && (
        <span className="avatar-image-message" role="status">
          照片加载中…
        </span>
      )}
      {showStatus && failed === src && src && (
        <span className="avatar-image-message" role="alert">
          照片加载失败，请重试或更换照片
        </span>
      )}
      {showStatus &&
        loaded.src === src &&
        failed !== src &&
        (loaded.width < 512 || loaded.height < 256) && (
          <span className="avatar-image-quality">
            原图 {loaded.width}×{loaded.height}，分辨率较低
          </span>
        )}
    </span>
  );
}
