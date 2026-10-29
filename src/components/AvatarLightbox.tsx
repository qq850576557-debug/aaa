import { useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import type { AvatarAccount } from './Avatar';
export function AvatarLightbox({
  account,
  onClose,
}: {
  account: AvatarAccount;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const source = account.cardAvatarVersion
    ? `/api/accounts/${encodeURIComponent(account.id)}/card-avatar?v=${encodeURIComponent(account.cardAvatarVersion)}`
    : '';
  return (
    <Modal title="名片照片预览" className="avatar-lightbox" blocking animateClose onClose={onClose}>
      <div className="modal-body">
        {!source ? (
          <p>尚未设置名片照片，可返回名片更换照片。</p>
        ) : status === 'error' ? (
          <div className="photo-failure" role="alert">
            <ImageOff size={30} />
            <p>照片暂时无法加载，请关闭后重试。</p>
            <button onClick={() => setStatus('loading')}>重新加载</button>
          </div>
        ) : (
          <>
            {status === 'loading' && (
              <div className="photo-loading" role="status">
                <Loader2 className="spin" size={22} />
                正在加载照片…
              </div>
            )}
            <img
              src={source}
              alt={`${account.displayName || account.login}的名片照片`}
              decoding="async"
              onLoad={(e) => {
                setSize({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                });
                setStatus('ready');
              }}
              onError={() => setStatus('error')}
            />
            {status === 'ready' && (
              <p className="photo-resolution">
                原图 {size.width} × {size.height}
                {size.width < 512 || size.height < 256
                  ? ' · 原图分辨率较低，放大不会增加细节；可更换清晰照片。'
                  : ' · 保留保存时的比例'}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
