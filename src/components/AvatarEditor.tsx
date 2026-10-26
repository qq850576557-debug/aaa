import { useEffect, useState } from 'react';
import { cloudApi, type CloudUser } from '../lib/cloud';
export function AvatarEditor({ user }: { user: CloudUser }) {
  const [preview, setPreview] = useState(''),
    [candidate, setCandidate] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`/api/accounts/${encodeURIComponent(user.id)}/avatar`)
      .then(async (r) => {
        if (r.ok) {
          const blob = await r.blob();
          const reader = new FileReader();
          reader.onload = () => {
            if (active) setPreview(String(reader.result));
          };
          reader.readAsDataURL(blob);
        }
      })
      .catch(() => {
        if (active) setError('头像暂时无法读取，请稍后重试');
      });
    return () => {
      active = false;
    };
  }, [user.id]);
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
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw Error('浏览器无法预览图片');
        const side = Math.min(bitmap.width, bitmap.height);
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
        setCandidate(canvas.toDataURL('image/png'));
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
      await cloudApi('/auth/avatar', remove ? 'DELETE' : 'PUT', remove ? {} : { image: candidate });
      setPreview(remove ? '' : candidate);
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
      <summary>头像设置</summary>
      <div className="avatar-preview account-avatar">
        {candidate || preview ? (
          <img src={candidate || preview} alt="头像预览" />
        ) : (
          Array.from(user.displayName || user.login)[0]
        )}
      </div>
      <label>
        选择头像
        <input
          type="file"
          aria-label="选择头像"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      <p className="account-muted">小于2MB · PNG、JPEG、WebP · 保存时裁切为圆形头像</p>
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
      {preview && (
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
