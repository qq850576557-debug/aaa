import { useRef, useState, type RefObject } from 'react';
import { Avatar } from './Avatar';
import { PhotoCropper, type PhotoSource } from './PhotoCropper';
import {
  AVATAR_MIN_SIDE,
  AVATAR_MAX_BYTES,
  AVATAR_RESOLUTION_ERROR,
  type Crop,
} from '../lib/avatar-crop';
import { cloudApi, cloudSession, type CloudUser } from '../lib/cloud';
export function AvatarEditor({
  user,
  onUpdated,
  kind = 'system',
  inputRef,
  aspect = 1,
}: {
  user: CloudUser;
  onUpdated: (user: CloudUser) => void;
  kind?: 'system' | 'card';
  inputRef?: RefObject<HTMLInputElement | null>;
  aspect?: number;
}) {
  const [photo, setPhoto] = useState<PhotoSource | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const localInput = useRef<HTMLInputElement>(null),
    fileInput = inputRef || localInput,
    saving = useRef(false),
    choosing = useRef(0);
  async function choose(file?: File) {
    if (!file || saving.current) return;
    const seq = ++choosing.current;
    setError('');
    setNotice('');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
        throw Error('请选择 PNG、JPEG 或 WebP 照片');
      if (file.size > AVATAR_MAX_BYTES)
        throw Error('原图不能超过10MB，请选择保留高清尺寸的 JPEG 照片');
      const bitmap = await createImageBitmap(file);
      let width, height;
      try {
        width = bitmap.width;
        height = bitmap.height;
        if (Math.min(width, height) < AVATAR_MIN_SIDE) throw Error(AVATAR_RESOLUTION_ERROR);
        if (width * height > 16000000) throw Error('图片像素超过1600万，请选择较小的高清原图');
      } finally {
        bitmap.close();
      }
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(Error('图片无法读取，请重试'));
        reader.readAsDataURL(file);
      });
      if (seq === choosing.current)
        setPhoto({ image, width, height, aspect: kind === 'card' ? aspect : 1 });
    } catch (e) {
      if (seq === choosing.current)
        setError(
          e instanceof DOMException
            ? '图片无法读取，请选择有效的 PNG、JPEG 或 WebP 原图'
            : e instanceof Error
              ? e.message
              : '图片无法读取，请选择有效原图',
        );
    }
  }
  async function save(crop?: Crop, remove = false) {
    if (saving.current || (!remove && !photo)) return;
    saving.current = true;
    setBusy(true);
    setError('');
    let uploaded = false;
    try {
      await cloudApi(
        kind === 'card' ? '/auth/card-avatar' : '/auth/avatar',
        remove ? 'DELETE' : 'PUT',
        remove ? {} : { image: photo!.image, crop },
      );
      uploaded = true;
      const updated = await cloudSession();
      onUpdated(updated);
      window.dispatchEvent(new CustomEvent('chunmo-profile-updated', { detail: updated }));
      window.dispatchEvent(new Event('chunmo-presence'));
      setPhoto(null);
      setNotice(remove ? '已恢复默认头像' : '头像已保存');
    } catch (e) {
      const message = e instanceof Error ? e.message : '照片保存失败，请重试';
      setError(
        uploaded
          ? '照片已保存，但资料刷新失败。可重试刷新，不会重复创建图片。'
          : `${message}。已保留照片和裁切位置，可直接重试。`,
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const input = (
    <input
      ref={fileInput}
      type="file"
      hidden
      aria-label={kind === 'card' ? '选择名片头像' : '选择头像'}
      accept="image/png,image/jpeg,image/webp"
      disabled={busy}
      onChange={(e) => {
        void choose(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );
  const messages = (
    <>
      {error && !photo && (
        <p className="photo-upload-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="photo-upload-notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
  const cropper = photo && (
    <PhotoCropper
      key={photo.image}
      source={photo}
      busy={busy}
      error={error}
      onClose={() => {
        if (!busy) {
          setPhoto(null);
          setError('');
        }
      }}
      onChoose={() => fileInput.current?.click()}
      onSave={(crop) => void save(crop)}
      onRemove={
        (kind === 'card' ? user.cardAvatarVersion : user.avatarVersion)
          ? () => void save(undefined, true)
          : undefined
      }
    />
  );
  if (kind === 'card')
    return (
      <div className="card-photo-upload">
        {input}
        {messages}
        {cropper}
      </div>
    );
  return (
    <details className="account-card avatar-editor">
      <summary>头像设置</summary>
      <div className="avatar-preview">
        <Avatar account={user} label="头像预览" />
      </div>
      {input}
      <button onClick={() => fileInput.current?.click()} disabled={busy}>
        选择头像
      </button>
      <p className="account-muted">
        原图短边至少720px，建议1080px以上 · PNG、JPEG、WebP · 最大10MB
      </p>
      {user.avatarVersion && (
        <button disabled={busy} onClick={() => void save(undefined, true)}>
          恢复默认头像
        </button>
      )}
      {messages}
      {cropper}
    </details>
  );
}
