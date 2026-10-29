import { useState, type RefObject } from 'react';
import { Avatar } from './Avatar';
import { cloudApi, cloudSession, type CloudUser } from '../lib/cloud';
export function AvatarEditor({
  user,
  onUpdated,
  kind = 'system',
  inputRef,
}: {
  user: CloudUser;
  onUpdated: (user: CloudUser) => void;
  kind?: 'system' | 'card';
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [candidate, setCandidate] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  async function choose(file?: File) {
    setError('');
    setNotice('');
    setCandidate('');
    if (!file) return;
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size >= 2 * 1024 * 1024
    ) {
      setError('请选择小于2MB的 PNG、JPEG 或 WebP 图片');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width * bitmap.height > 16000000) throw Error('图片尺寸过大，请选择较小的图片');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw Error('浏览器无法预览图片');
        const side = Math.min(bitmap.width, bitmap.height);
        let scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
        let encoded = '';
        for (let attempt = 0; attempt < 10; attempt++) {
          canvas.width = kind === 'card' ? Math.max(1, Math.round(bitmap.width * scale)) : 256;
          canvas.height = kind === 'card' ? Math.max(1, Math.round(bitmap.height * scale)) : 256;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          if (kind === 'card') ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          else
            ctx.drawImage(
              bitmap,
              (bitmap.width - side) / 2,
              (bitmap.height - side) / 2,
              side,
              side,
              0,
              0,
              256,
              256,
            );
          encoded = canvas.toDataURL('image/png');
          if (((encoded.length - 'data:image/png;base64,'.length) * 3) / 4 < 2 * 1024 * 1024) break;
          encoded = '';
          scale *= 0.85;
        }
        if (!encoded) throw Error('处理后的图片仍过大，请选择较小的照片');
        setCandidate(encoded);
      } finally {
        bitmap.close();
      }
    } catch {
      setError('图片无法读取，请选择有效的图片文件');
    }
  }
  async function save(remove = false) {
    setBusy(true);
    setError('');
    try {
      await cloudApi(
        kind === 'card' ? '/auth/card-avatar' : '/auth/avatar',
        remove ? 'DELETE' : 'PUT',
        remove ? {} : { image: candidate },
      );
      const updated = await cloudSession();
      onUpdated(updated);
      window.dispatchEvent(new CustomEvent('chunmo-profile-updated', { detail: updated }));
      setCandidate('');
      setNotice(remove ? '已恢复默认头像' : '头像已保存');
      window.dispatchEvent(new Event('chunmo-presence'));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="account-card avatar-editor">
      <summary>{kind === 'card' ? '名片头像设置' : '头像设置'}</summary>
      <div className="avatar-preview">
        <Avatar
          account={user}
          source={candidate || undefined}
          kind={kind}
          label={kind === 'card' ? '名片头像预览' : '头像预览'}
        />
      </div>
      <label>
        选择头像
        <input
          ref={inputRef}
          type="file"
          aria-label={kind === 'card' ? '选择名片头像' : '选择头像'}
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      <p className="account-muted">
        小于2MB · PNG、JPEG、WebP ·{' '}
        {kind === 'card'
          ? '保留原比例，长边最多1024px；与在线头像独立保存'
          : '保存时裁切为圆形头像'}
      </p>
      {candidate && (
        <div className="toolbar">
          <button disabled={busy} onClick={() => void save()}>
            保存头像
          </button>
          <button disabled={busy} onClick={() => setCandidate('')}>
            取消预览
          </button>
        </div>
      )}
      {(kind === 'card' ? user.cardAvatarVersion : user.avatarVersion) && (
        <button disabled={busy} onClick={() => void save(true)}>
          恢复默认头像
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
