import { useEffect, useRef, useState } from 'react';
import type { Project } from '../lib/model';
import { cloudApi, type CloudUser } from '../lib/cloud';
import { photoTime, type PhotoInput, type PhotoMeta } from '../lib/site-photo';
import { renderPhoto } from '../lib/photo-render';
import { localPhotos, saveLocalPhoto, syncPhotos, type LocalPhoto } from '../lib/photo-queue';
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function PhotoAssistant({
  projects,
  user,
  projectId,
  onProject,
}: {
  projects: Project[];
  user: CloudUser;
  projectId: string;
  onProject: (id: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(20);
  const [file, setFile] = useState<File | null>(null),
    [location, setLocation] = useState<PhotoInput['location']>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [queue, setQueue] = useState<LocalPhoto[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof renderPhoto>> | null>(null),
    [url, setUrl] = useState(''),
    [actorName, setActorName] = useState(user.displayName || user.login);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const capture = useRef({
    at: new Date().toISOString(),
    source: 'file-selection' as PhotoInput['captureSource'],
  });
  const mounted = useRef(true),
    generation = useRef(0),
    shot = useRef<HTMLInputElement>(null),
    album = useRef<HTMLInputElement>(null);
  const refresh = () =>
    void localPhotos(user)
      .then((rows) => {
        if (mounted.current)
          setQueue(
            rows.sort((a, b) =>
              (b.localSavedAt || b.input.capturedAt).localeCompare(
                a.localSavedAt || a.input.capturedAt,
              ),
            ),
          );
      })
      .catch((e) => setMessage(String(e)));
  useEffect(() => {
    mounted.current = true;
    refresh();
    void cloudApi<{ enabled: boolean; actorName: string }>('/site-photos/config')
      .then((c) => {
        if (mounted.current) {
          setEnabled(c.enabled);
          setActorName(c.actorName);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [user.id]);
  useEffect(() => {
    const update = () => refresh();
    window.addEventListener('chunmo-photos-local', update);
    return () => window.removeEventListener('chunmo-photos-local', update);
  }, [user.id]);
  useEffect(() => {
    if (!preview) {
      setUrl('');
      return;
    }
    const u = URL.createObjectURL(preview.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [preview]);
  useEffect(() => {
    setPreview(null);
    if (!file || !projectId) return;
    const token = ++generation.current;
    setBusy(true);
    const meta: PhotoMeta = {
      requestId: crypto.randomUUID(),
      projectId,
      projectName: projects.find((p) => p.id === projectId)?.name || '',
      actorId: user.id,
      actorName,
      capturedAt: capture.current.at,
      captureSource: capture.current.source,
      originalName: file.name,
      originalSize: file.size,
      outputWidth: 1,
      outputHeight: 1,
      location,
    };
    void renderPhoto(file, meta)
      .then((result) => {
        if (token === generation.current) setPreview(result);
      })
      .catch((e) => {
        if (token === generation.current) setMessage(String(e));
      })
      .finally(() => {
        if (token === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [file, projectId, location, actorName]);
  function locate() {
    if (!navigator.geolocation) {
      setMessage('定位未获取，仍可拍照');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (mounted.current) {
          setLocation({
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracy: p.coords.accuracy,
            obtainedAt: new Date(p.timestamp).toISOString(),
          });
          setMessage('');
        }
      },
      () => {
        if (mounted.current) {
          setLocation(null);
          setMessage('定位未获取，仍可保存照片');
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }
  async function select(f: File | undefined) {
    if (!f) return;
    setMessage('');
    setFile(f);
    try {
      if ((await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted')
        locate();
    } catch {
      /* Safari may not expose permission query. */
    }
  }
  async function save() {
    if (!preview || !file || busy) return;
    setBusy(true);
    try {
      const {
        requestId,
        projectId,
        capturedAt,
        captureSource,
        originalName,
        originalSize,
        outputWidth,
        outputHeight,
        location,
      } = preview.meta;
      const input: PhotoInput = {
        requestId,
        projectId,
        capturedAt,
        captureSource,
        originalName,
        originalSize,
        outputWidth,
        outputHeight,
        location,
      };
      await saveLocalPhoto({
        owner: { id: user.id, workspaceId: user.workspaceId },
        input,
        meta: preview.meta,
        original: file,
        watermarked: preview.blob,
        state: 'pending',
      });
      void navigator.storage?.persist?.().catch(() => {});
      setFile(null);
      setPreview(null);
      setMessage('本地已保存，待云端确认');
      void syncPhotos(user);
    } catch (e) {
      setMessage(`本地保存失败，请先下载照片并保留原图：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mobile-photo">
      <h2>工地拍照水印</h2>
      <label>
        所属工地
        <select
          aria-label="拍照所属工地"
          value={projectId}
          onChange={(e) => onProject(e.target.value)}
        >
          <option value="">选择工地</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mobile-actions">
        <button
          disabled={!projectId || busy}
          onClick={() => {
            capture.current = { at: new Date().toISOString(), source: 'camera-request' };
            shot.current?.click();
          }}
        >
          拍摄照片
        </button>
        <button
          disabled={!projectId || busy}
          onClick={() => {
            capture.current = { at: new Date().toISOString(), source: 'file-selection' };
            album.current?.click();
          }}
        >
          从相册选择原图
        </button>
      </div>
      <input
        ref={shot}
        aria-label="拍摄照片文件"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void select(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={album}
        aria-label="相册原图文件"
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void select(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="mobile-actions">
        <button onClick={locate}>授权获取本次定位</button>
        {location && <button onClick={() => setLocation(null)}>不使用定位</button>}
      </div>
      <p>
        {location
          ? `GPS ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} · 约±${Math.round(location.accuracy)}米`
          : '定位：未获取'}
      </p>
      {enabled === false && <p role="status">云端照片存储待启用；可本地保存和下载。</p>}
      {message && <p role="status">{message}</p>}
      {file && <button onClick={() => download(file, file.name || '春茉-原图')}>下载原图</button>}
      {busy && <p role="status">正在处理照片…</p>}
      {preview && (
        <div className="photo-preview">
          <img src={url} alt="原图比例水印预览" />
          <p>
            原图 {preview.originalWidth}×{preview.originalHeight} · 水印图 {preview.width}×
            {preview.height}
          </p>
          {(preview.width !== preview.originalWidth ||
            preview.height !== preview.originalHeight) && (
            <p role="alert">为控制设备内存，水印图降为以上尺寸，原图完整保留。</p>
          )}
          <p>
            {preview.meta.captureSource === 'exif'
              ? `原图EXIF：${preview.exifRaw}`
              : preview.meta.captureSource === 'file-selection'
                ? '原图未提供可读拍摄时间，水印明确使用选图时间。'
                : '时间为相机调用时设备时间，不作为严格考勤证明。'}
          </p>
          <div className="mobile-actions">
            <button disabled={busy} onClick={() => void save()}>
              确认保存
            </button>
            <button onClick={() => download(preview.blob, '春茉-水印.jpg')}>下载水印照片</button>
            <button
              onClick={() => {
                setFile(null);
                setPreview(null);
              }}
            >
              重新选择照片
            </button>
          </div>
        </div>
      )}
      <h3>本机照片</h3>
      <button
        onClick={() => {
          setMessage('正在重试上传');
          void syncPhotos(user).then(() => setMessage('本次同步检查完成'));
        }}
      >
        重试上传
      </button>
      {queue.slice(0, visibleCount).map((p) => (
        <article className="mobile-photo-row" key={p.input.requestId}>
          <strong>{p.meta.projectName}</strong>
          <p>
            {photoTime(p.meta.capturedAt)} ·{' '}
            {p.state === 'uploaded' ? '云端已确认' : '本地已保存·待同步'}
          </p>
          {p.message && <p role="alert">{p.message}</p>}
          <div className="mobile-actions">
            <button onClick={() => download(p.original, p.input.originalName || '春茉-原图')}>
              原图
            </button>
            <button onClick={() => download(p.watermarked, '春茉-水印.jpg')}>本地水印图</button>
            {p.state === 'uploaded' && (
              <a
                href={`/api/site-photos/${encodeURIComponent(user.id)}/${p.input.requestId}/watermarked`}
              >
                云端水印图
              </a>
            )}
          </div>
        </article>
      ))}
      {queue.length > visibleCount && (
        <button onClick={() => setVisibleCount((n) => n + 20)}>显示更多本机照片</button>
      )}
    </section>
  );
}
