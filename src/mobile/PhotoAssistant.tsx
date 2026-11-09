import { exifCapture } from '../lib/photo-exif';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../lib/model';
import { cloudApi, type CloudUser } from '../lib/cloud';
import { photoTime, type PhotoMeta, type PhotoInput } from '../lib/site-photo';
import { freshLocation, type PlaceReceipt, type PhotoLocation } from '../lib/photo-location';
import { renderPhoto } from '../lib/photo-render';
import { imageBlob, imageDataUrl, sharePhoto } from '../lib/photo-image';
import { localPhotos, saveLocalPhoto, syncPhotos, type LocalPhoto } from '../lib/photo-queue';
import { Modal } from '../components/Modal';
function locationNow() {
  return new Promise<PhotoLocation>((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(Error('此浏览器不支持定位，请使用HTTPS的Safari或Chrome'));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const loc = {
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
          obtainedAt: new Date(p.timestamp).toISOString(),
        };
        freshLocation(loc)
          ? resolve(loc)
          : reject(Error('定位精度不足或位置已过期，请到开阔处重新定位'));
      },
      (e) =>
        reject(
          Error(
            e.code === 1
              ? '定位被拒绝。请在iPhone设置→隐私与安全性→定位服务→Safari网站中允许定位，并在Safari网站设置中允许本网站定位。'
              : e.code === 3
                ? '定位超时，请到开阔处重试'
                : '定位失败，请检查系统定位后重试',
          ),
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });
}
function request(meta: PhotoMeta): PhotoInput {
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
    placeToken,
  } = meta;
  return {
    requestId,
    projectId,
    capturedAt,
    captureSource,
    originalName,
    originalSize,
    outputWidth,
    outputHeight,
    location,
    ...(placeToken ? { placeToken } : {}),
  };
}
function Thumbnail({ photo }: { photo: LocalPhoto }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    void imageDataUrl(photo.watermarked?.size ? photo.watermarked : photo.original)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [photo.input.requestId, photo.state]);
  return src ? (
    <img loading="lazy" className="photo-thumbnail" src={src} alt="本机照片缩略图" />
  ) : (
    <span className="photo-thumbnail">照片</span>
  );
}
export function PhotoAssistant({
  projects,
  user,
  projectId,
  onProject,
  startRequest = 0,
  onSessionChange,
}: {
  projects: Project[];
  user: CloudUser;
  projectId: string;
  onProject: (id: string) => void;
  startRequest?: number;
  onSessionChange?: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'camera' | 'native' | 'error'>('idle'),
    [status, setStatus] = useState(''),
    [queue, setQueue] = useState<LocalPhoto[]>([]),
    [busy, setBusy] = useState(false),
    [count, setCount] = useState(0),
    [place, setPlace] = useState<PlaceReceipt | null>(null),
    [config, setConfig] = useState<{
      enabled: boolean;
      geocodingEnabled: boolean;
      actorName: string;
      storageStatus?: string;
    } | null>(null),
    [viewer, setViewer] = useState<{
      photo: LocalPhoto;
      kind: 'original' | 'watermarked';
      blob: Blob;
      src: string;
      width?: number;
      height?: number;
    } | null>(null),
    [shareStatus, setShareStatus] = useState(''),
    [visible, setVisible] = useState(20),
    [pixels, setPixels] = useState(''),
    [unsaved, setUnsaved] = useState<LocalPhoto | null>(null),
    [locationValid, setLocationValid] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    native = useRef<HTMLInputElement>(null),
    stream = useRef<MediaStream | null>(null),
    receipt = useRef<PlaceReceipt | null>(null),
    active = useRef(true),
    generation = useRef(0),
    shutterBusy = useRef(false),
    functions = useRef({ start: async () => {} }),
    nativeReceipt = useRef<PlaceReceipt | null>(null);
  const refresh = () =>
    void localPhotos(user)
      .then((rows) => {
        if (active.current)
          setQueue(
            rows.sort((a, b) =>
              (b.localSavedAt || b.input.capturedAt).localeCompare(
                a.localSavedAt || a.input.capturedAt,
              ),
            ),
          );
      })
      .catch(() => {
        if (active.current) setStatus('本地照片读取异常，请保留网站数据后重试');
      });
  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => {
    active.current = true;
    refresh();
    void cloudApi<NonNullable<typeof config>>('/site-photos/config')
      .then((c) => {
        if (active.current) setConfig(c);
      })
      .catch(() => {});
    const update = () => refresh();
    window.addEventListener('chunmo-photos-local', update);
    return () => {
      active.current = false;
      generation.current++;
      stop();
      onSessionChange?.(false);
      window.removeEventListener('chunmo-photos-local', update);
    };
  }, [user.id]);
  useEffect(() => {
    onSessionChange?.(['starting', 'camera', 'native'].includes(phase));
  }, [phase]);
  useEffect(() => {
    if (phase === 'camera' && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current.play().catch(() => {
        stop();
        setStatus('网页相机预览不可用，可打开系统相机');
        setPhase('native');
      });
    }
  }, [phase]);
  useEffect(() => {
    if (!startRequest) return;
    const timer = setTimeout(() => void functions.current.start(), 0);
    return () => clearTimeout(timer);
  }, [startRequest]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        setPhase((p) => (p === 'camera' ? 'idle' : p));
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  useEffect(() => {
    if (!unsaved) return;
    const leaving = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const switching = (e: MouseEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest(
          '.assistant-header button,.assistant-nav button,.assistant-content > button',
        )
      ) {
        e.preventDefault();
        e.stopPropagation();
        setStatus('原图尚未写入本机，请先重试保存，或确认自行备份后再退出');
      }
    };
    window.addEventListener('beforeunload', leaving);
    document.addEventListener('click', switching, true);
    return () => {
      window.removeEventListener('beforeunload', leaving);
      document.removeEventListener('click', switching, true);
    };
  }, [unsaved]);
  async function ensurePlace() {
    const loc = await locationNow();
    if (!active.current) throw Error('拍摄已结束');
    const old = receipt.current;
    const moved = old
      ? Math.hypot(
          (loc.latitude - old.location.latitude) * 111320,
          (loc.longitude - old.location.longitude) *
            111320 *
            Math.cos((loc.latitude * Math.PI) / 180),
        )
      : Infinity;
    if (
      old &&
      freshLocation(old.location) &&
      Date.now() - Date.parse(old.location.obtainedAt) < 30000 &&
      moved <= 25
    )
      return old;
    const p = await cloudApi<PlaceReceipt>('/site-photos/location', 'POST', { location: loc });
    if (!freshLocation(p.location) || !p.placeName || !p.token)
      throw Error('地点识别未确认，请重试');
    if (active.current) {
      receipt.current = p;
      setPlace(p);
    }
    return p;
  }
  async function start() {
    if (shutterBusy.current) return;
    const token = ++generation.current;
    stop();
    receipt.current = null;
    setPlace(null);
    setCount(0);
    setPhase('starting');
    setStatus('正在定位并识别小区…');
    try {
      const p = await ensurePlace();
      if (!active.current || token !== generation.current) return;
      setStatus('');
      setPlace(p);
      if (!navigator.mediaDevices?.getUserMedia) {
        setPhase('native');
        return;
      }
      try {
        const camera = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 4096 },
            height: { ideal: 3072 },
          },
        });
        if (!active.current || token !== generation.current) {
          camera.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = camera;
        const s = camera.getVideoTracks()[0].getSettings();
        setPixels(s.width && s.height ? `${s.width}×${s.height}` : '');
        setPhase('camera');
      } catch {
        if (active.current) {
          setStatus('网页相机不可用，请打开系统相机拍摄');
          setPhase('native');
        }
      }
    } catch (e) {
      if (active.current && token === generation.current) {
        setPhase('error');
        setStatus(String(e instanceof Error ? e.message : e));
      }
    }
  }
  useEffect(() => {
    if (phase !== 'camera' && phase !== 'native') return;
    const tick = () => setLocationValid(freshLocation(receipt.current?.location || null));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, place]);
  functions.current.start = start;
  async function finishWatermark(p: LocalPhoto) {
    if (['live-camera', 'native-camera'].includes(p.meta.captureSource) && !p.meta.placeToken)
      throw Error('本次拍摄缺少有效定位，原图保留，请重新拍摄');
    const file = new File([await imageBlob(p.original)], p.input.originalName, {
      type: p.original.type || 'image/jpeg',
    });
    const result = await renderPhoto(file, p.meta);
    await saveLocalPhoto({
      ...p,
      meta: result.meta,
      input: request(result.meta),
      watermarked: result.blob,
      state: 'pending',
      message:
        result.width !== result.originalWidth || result.height !== result.originalHeight
          ? `原图${result.originalWidth}×${result.originalHeight}；水印输出${result.width}×${result.height}（设备降级）`
          : '',
    });
    void syncPhotos(user);
  }
  async function persist(
    blob: Blob,
    p: PlaceReceipt,
    source: 'live-camera' | 'native-camera',
    capturedAt: string,
  ) {
    const meta: PhotoMeta = {
      requestId: crypto.randomUUID(),
      projectId: projects.some((x) => x.id === projectId) ? projectId : '',
      projectName: projects.find((x) => x.id === projectId)?.name || '',
      capturedAt,
      captureSource: source,
      originalName: `春茉-${capturedAt.replace(/[:.]/g, '-')}.jpg`,
      originalSize: blob.size,
      outputWidth: 1,
      outputHeight: 1,
      location: p.location,
      placeToken: p.token,
      placeName: p.placeName,
      placeSource: p.placeSource,
      nearby: true,
      actorId: user.id,
      actorName: config?.actorName || user.displayName || user.login,
    };
    const photo: LocalPhoto = {
      owner: { id: user.id, workspaceId: user.workspaceId },
      input: request(meta),
      meta,
      original: blob,
      watermarked: new Blob([], { type: 'image/jpeg' }),
      state: 'captured',
    };
    try {
      await saveLocalPhoto(photo);
      if (active.current) setCount((n) => n + 1);
      void navigator.storage?.persist?.().catch(() => {});
    } catch {
      if (active.current) {
        setUnsaved(photo);
        setStatus('原图尚未写入应用本地，请保留页面，预览存图或重试本地保存');
      }
      return;
    }
    try {
      await finishWatermark(photo);
      if (active.current) setStatus('');
    } catch (e) {
      await saveLocalPhoto({ ...photo, message: `原图已保留，水印待重试：${String(e)}` });
      if (active.current) setStatus('水印生成失败，原图已保存到应用本地');
    }
  }
  async function capture() {
    if (shutterBusy.current || unsaved) return;
    shutterBusy.current = true;
    setBusy(true);
    try {
      const p = await ensurePlace();
      if (!active.current || phase !== 'camera' || !stream.current) throw Error('相机会话已结束');
      const at = new Date().toISOString(),
        track = stream.current.getVideoTracks()[0];
      let blob: Blob | undefined;
      const IC = (window as any).ImageCapture;
      if (IC) {
        try {
          blob = await new IC(track).takePhoto();
        } catch {
          /* Native still capture is optional; actual video pixels remain the fallback. */
        }
      }
      if (!blob) {
        const v = video.current;
        if (!v?.videoWidth || !v.videoHeight) throw Error('相机未就绪');
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        if (!ctx) throw Error('相机画面读取失败');
        ctx.drawImage(v, 0, 0);
        blob = await new Promise<Blob>((resolve, reject) =>
          c.toBlob((b) => (b ? resolve(b) : reject(Error('拍照编码失败'))), 'image/jpeg', 0.98),
        );
        c.width = c.height = 0;
      }
      await persist(blob, p, 'live-camera', at);
    } catch (e) {
      if (active.current) setStatus(String(e instanceof Error ? e.message : e));
    } finally {
      shutterBusy.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function nativeShot(file: File | undefined) {
    if (!file || !nativeReceipt.current) return;
    setBusy(true);
    try {
      const p = nativeReceipt.current;
      const exif = exifCapture(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
      const at = exif?.at || new Date().toISOString();
      if (
        !freshLocation(p.location, Math.max(Date.parse(at), Date.parse(p.location.obtainedAt))) ||
        Date.parse(at) < Date.parse(p.location.obtainedAt) - 5000
      ) {
        // Keep the original even if native camera stayed open past the location lease.
        const m: PhotoMeta = {
          requestId: crypto.randomUUID(),
          projectId: '',
          projectName: '',
          capturedAt: at,
          captureSource: 'native-camera',
          originalName: file.name,
          originalSize: file.size,
          outputWidth: 1,
          outputHeight: 1,
          location: p.location,
          actorId: user.id,
          actorName: config?.actorName || user.displayName || user.login,
        };
        const pendingOriginal: LocalPhoto = {
          owner: user,
          input: request(m),
          meta: m,
          original: file,
          watermarked: new Blob([], { type: 'image/jpeg' }),
          state: 'captured',
          message: '系统相机停留时间过长，定位已过期；原图已保留，不能伪装为本次有效定位照片',
        };
        try {
          await saveLocalPhoto(pendingOriginal);
        } catch {
          setUnsaved(pendingOriginal);
          setStatus('原图未写入本机，请保留页面并预览存图或重试本地保存');
          return;
        }
        setCount((n) => n + 1);
        setStatus('原图已保存，本次定位已过期，请重新定位拍摄');
        return;
      }
      await persist(file, p, 'native-camera', at);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function openPhoto(p: LocalPhoto, kind: 'original' | 'watermarked') {
    setShareStatus('');
    try {
      let b: Blob;
      try {
        b = await imageBlob(kind === 'original' ? p.original : p.watermarked);
        if (!b.size) throw Error('水印尚未生成');
        await new Promise<void>((resolve, reject) => {
          void imageDataUrl(b)
            .then((src) => {
              const i = new Image();
              i.onload = () => resolve();
              i.onerror = () => reject(Error('图片暂时无法解码'));
              i.src = src;
            })
            .catch(reject);
        });
      } catch (e) {
        if (p.state !== 'uploaded') throw e;
        const r = await fetch(
          `/api/site-photos/${encodeURIComponent(user.id)}/${p.input.requestId}/${kind}`,
          { credentials: 'same-origin', cache: 'no-store' },
        );
        if (!r.ok) throw Error('云端副本暂不可用，请保留本地记录并重试');
        b = await imageBlob(await r.blob());
      }
      const src = await imageDataUrl(b);
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(Error('图片无法解码'));
        img.src = src;
      });
      if (active.current) setViewer({ photo: p, kind, blob: b, src, ...dimensions });
    } catch (e) {
      setStatus(`照片读取失败，未删除原记录：${String(e)}`);
    }
  }
  async function associate(p: LocalPhoto, id: string) {
    onProject(id);
    await saveLocalPhoto({
      ...p,
      association: {
        requestId: crypto.randomUUID(),
        projectId: id,
        version: p.meta.associationVersion || 0,
      },
    });
    void syncPhotos(user);
  }
  return (
    <section className="mobile-photo photo-v11">
      <h2 className="sr-only">现场拍照</h2>
      {config && !config.enabled && (
        <p className="photo-storage-status" role="status">
          {config.storageStatus === 'disabled'
            ? '云端未配置照片目录'
            : config.storageStatus === 'low-space'
              ? '云端剩余空间不足'
              : '云端目录未准备或不可写'}{' '}
          · 本机照片保留
        </p>
      )}
      <strong className="camera-place">
        {place ? `附近：${place.placeName}` : '等待定位识别小区'}
      </strong>
      {status && (
        <p role="status" className="camera-status">
          {status}
        </p>
      )}
      {phase === 'starting' && <p role="status">正在准备拍摄…</p>}
      {phase === 'error' && <button onClick={() => void start()}>重试定位并拍照</button>}
      {phase === 'idle' && (
        <button className="camera-start" onClick={() => void start()}>
          拍照
        </button>
      )}
      {phase === 'camera' && !locationValid && (
        <button
          onClick={() =>
            void ensurePlace()
              .then(() => setStatus(''))
              .catch((e) => setStatus(String(e)))
          }
        >
          定位已过期，重试定位
        </button>
      )}
      {phase === 'camera' && (
        <>
          <video ref={video} autoPlay muted playsInline aria-label="后置相机实时预览" />
          <small className="camera-pixels">预览像素 {pixels || '由设备决定'}</small>
          <button
            className="native-camera-option"
            onClick={() => {
              stop();
              setPhase('native');
            }}
          >
            改用系统相机
          </button>
        </>
      )}
      {phase === 'native' && (
        <button
          className="camera-start"
          onClick={() => {
            if (receipt.current && freshLocation(receipt.current.location)) {
              nativeReceipt.current = receipt.current;
              native.current?.click();
            } else
              void ensurePlace()
                .then(() => setStatus('定位已更新，请再次点击打开系统相机'))
                .catch((e) => setStatus(String(e)));
          }}
        >
          打开系统相机
        </button>
      )}
      <input
        ref={native}
        aria-label="系统相机照片"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void nativeShot(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {['starting', 'camera', 'native'].includes(phase) && (
        <div className="camera-controls">
          <span>本次已拍 {count} 张</span>
          <button
            className="camera-shutter"
            disabled={phase !== 'camera' || busy || !!unsaved || !locationValid}
            onClick={() => void capture()}
          >
            拍照
          </button>
          <button
            onClick={() => {
              generation.current++;
              stop();
              setPhase('idle');
            }}
          >
            完成拍摄
          </button>
        </div>
      )}
      {unsaved && (
        <div role="alert">
          <p>原图未写入本机</p>
          <button onClick={() => void openPhoto(unsaved, 'original')}>预览并存入相册</button>
          <button
            onClick={() =>
              void saveLocalPhoto(unsaved)
                .then(() => {
                  setUnsaved(null);
                  setCount((n) => n + 1);
                  return finishWatermark(unsaved);
                })
                .catch((e) => setStatus(String(e)))
            }
          >
            重试本地保存
          </button>
          <button
            onClick={() => {
              if (
                confirm(
                  '此照片尚未存入应用本地。确认已在系统相册或其它安全位置保留原图后，才可退出本次未保存照片？',
                )
              )
                setUnsaved(null);
            }}
          >
            已自行备份，结束未保存照片
          </button>
        </div>
      )}
      <div className="photo-gallery-heading">
        <h3>本机照片</h3>
        <button onClick={() => void syncPhotos(user)}>重试上传</button>
      </div>
      {queue.slice(0, visible).map((p) => (
        <article className="mobile-photo-row" key={p.input.requestId}>
          <div className="photo-row-body">
            <button
              onClick={() => void openPhoto(p, p.watermarked?.size ? 'watermarked' : 'original')}
              aria-label="预览本机照片"
            >
              <Thumbnail photo={p} />
            </button>
            <div>
              <strong>
                {p.meta.placeName ? `附近：${p.meta.placeName}` : p.meta.projectName || '历史照片'}
              </strong>
              <p>{photoTime(p.meta.capturedAt)}</p>
              <p>
                {p.state === 'uploaded'
                  ? '已上传云端'
                  : p.state === 'captured'
                    ? '原图已保存到应用本地 · 待补水印'
                    : '已保存到应用本地 · 待上传'}
              </p>
            </div>
          </div>
          {p.message && <p role="status">{p.message}</p>}
          <div className="mobile-actions">
            <button onClick={() => void openPhoto(p, 'original')}>原图</button>
            <button
              disabled={!p.watermarked?.size && p.state !== 'uploaded'}
              onClick={() => void openPhoto(p, 'watermarked')}
            >
              水印图／存入相册
            </button>
            {p.state === 'captured' && (
              <button
                onClick={() =>
                  void finishWatermark(p).catch((e) => setStatus(`原图保留：${String(e)}`))
                }
              >
                重试水印
              </button>
            )}
          </div>
          <label className="photo-project-optional">
            归档工地（选填）
            <select
              aria-label={`照片归档工地${p.input.requestId}`}
              value={p.association?.projectId ?? p.meta.projectId}
              onChange={(e) => void associate(p, e.target.value).catch((e) => setStatus(String(e)))}
            >
              <option value="">未关联项目</option>
              {projects.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </article>
      ))}
      {queue.length > visible && (
        <button onClick={() => setVisible((n) => n + 20)}>显示更多本机照片</button>
      )}
      {viewer && (
        <Modal
          title={viewer.kind === 'original' ? '原图' : '水印图'}
          onClose={() => setViewer(null)}
          className="photo-viewer"
        >
          <div className="modal-body">
            <img
              src={viewer.src}
              alt={viewer.kind === 'original' ? '应用内原图预览' : '应用内水印图预览'}
            />
            <p>
              实际尺寸 {viewer.width}×{viewer.height}
            </p>
            <p>长按图片可选择“存储到照片”；应用无法静默写入iPhone相册。</p>
            <button
              onClick={() => {
                setShareStatus('');
                void sharePhoto(
                  viewer.blob,
                  viewer.kind === 'original' ? viewer.photo.input.originalName : '春茉-水印.jpg',
                )
                  .then((result) =>
                    setShareStatus(
                      result === 'shared'
                        ? '系统分享已结束，请到照片App核对是否保存；不代表自动写入相册'
                        : '请长按上方图片，选择“存储到照片”',
                    ),
                  )
                  .catch((e) =>
                    setShareStatus(
                      (e as DOMException).name === 'AbortError'
                        ? '已取消系统分享，应用本地照片仍保留'
                        : '系统分享不可用，请长按上方图片存储',
                    ),
                  );
              }}
            >
              存入相册
            </button>
            {shareStatus && <p role="status">{shareStatus}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}
