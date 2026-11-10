import { exifCapture } from '../lib/photo-exif';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../lib/model';
import { cloudApi, type CloudUser } from '../lib/cloud';
import { photoTime, type PhotoMeta, type PhotoInput } from '../lib/site-photo';
import {
  freshLocation,
  freshPlace,
  type PlaceReceipt,
  type PhotoLocation,
} from '../lib/photo-location';
import { preparePhotoRenderer, renderPhoto } from '../lib/photo-render';
import { imageBlob, imageDataUrl, sharePhoto } from '../lib/photo-image';
import {
  localPhotos,
  localPhoto,
  updateLocalPhoto,
  saveLocalPhoto,
  syncPhotos,
  type LocalPhoto,
} from '../lib/photo-queue';
import { Modal } from '../components/Modal';
import { photoStage, photoTiming } from '../lib/photo-performance';
const watermarkJobs = new Map<string, Promise<void>>();
function locationNow() {
  return photoStage(
    'gps',
    () =>
      new Promise<PhotoLocation>((resolve, reject) => {
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
      }),
  );
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
    if (photo.state === 'captured' && !photo.thumbnail) return;
    void imageDataUrl(
      photo.thumbnail || (photo.watermarked?.size ? photo.watermarked : photo.original),
    )
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [
    photo.input.requestId,
    photo.thumbnail?.size ? 'thumb' : photo.watermarked?.size ? 'watermark' : 'original',
  ]);
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
    [locationValid, setLocationValid] = useState(false),
    [previewReady, setPreviewReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    native = useRef<HTMLInputElement>(null),
    stream = useRef<MediaStream | null>(null),
    receipt = useRef<PlaceReceipt | null>(null),
    active = useRef(true),
    generation = useRef(0),
    shutterBusy = useRef(false),
    functions = useRef({ start: async () => {} }),
    nativeReceipt = useRef<PlaceReceipt | null>(null);
  const startedAt = useRef(0);
  const placeFlight = useRef<Promise<PlaceReceipt> | null>(null);
  const readyMeasured = useRef(false);
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
    void localPhotos(user)
      .then((rows) => {
        if (!active.current) return;
        setQueue(
          rows.sort((a, b) =>
            (b.localSavedAt || b.input.capturedAt).localeCompare(
              a.localSavedAt || a.input.capturedAt,
            ),
          ),
        );
        for (const p of rows)
          if (p.state === 'captured' && p.meta.placeToken) void backgroundWatermark(p);
      })
      .catch(() => setStatus('本地照片读取异常，请保留网站数据后重试'));
    void cloudApi<NonNullable<typeof config>>('/site-photos/config')
      .then((c) => {
        if (active.current) setConfig(c);
      })
      .catch(() => {});
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail?.id) {
        refresh();
        return;
      }
      if (detail.owner?.id !== user.id || detail.owner?.workspaceId !== user.workspaceId) return;
      void localPhoto(user, detail.id)
        .then((p) => {
          if (!p || !active.current) return;
          setQueue((old) =>
            [p, ...old.filter((row) => row.input.requestId !== p.input.requestId)].sort((a, b) =>
              (b.localSavedAt || b.input.capturedAt).localeCompare(
                a.localSavedAt || a.input.capturedAt,
              ),
            ),
          );
        })
        .catch(() => setStatus('本地照片读取异常，原记录保留'));
    };
    window.addEventListener('chunmo-photos-local', update);
    const storageError = () => setStatus('本地照片状态写入失败，原图保留；请保留网站数据并重试');
    window.addEventListener('chunmo-photos-storage-error', storageError);
    return () => {
      active.current = false;
      generation.current++;
      stop();
      onSessionChange?.(false);
      window.removeEventListener('chunmo-photos-local', update);
      window.removeEventListener('chunmo-photos-storage-error', storageError);
    };
  }, [user.id]);
  useEffect(() => {
    onSessionChange?.(['starting', 'camera', 'native'].includes(phase));
  }, [phase]);
  useEffect(() => {
    if (phase === 'camera' && video.current && stream.current) {
      video.current.srcObject = stream.current;
      setPreviewReady(false);
      const v = video.current;
      void v
        .play()
        .then(() => {
          const firstFrame = () => {
            if (!active.current || video.current !== v || !stream.current) return;
            setPreviewReady(true);
            photoTiming('click-preview', startedAt.current);
          };
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(firstFrame);
          else requestAnimationFrame(firstFrame);
        })
        .catch(() => {
          if (!active.current || video.current !== v) return;
          stop();
          setStatus('网页相机预览不可用，可打开系统相机');
          setPhase('native');
        });
    }
  }, [phase]);
  useEffect(() => {
    if (previewReady && locationValid && !readyMeasured.current) {
      readyMeasured.current = true;
      photoTiming('click-ready', startedAt.current);
    }
  }, [previewReady, locationValid]);
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
    if (freshPlace(receipt.current, Date.now(), 30000)) return receipt.current!;
    if (placeFlight.current) return placeFlight.current;
    const session = generation.current;
    const work = (async () => {
      const loc = await locationNow();
      if (!active.current || session !== generation.current) throw Error('拍摄已结束');
      const p = await photoStage('place-lookup', () =>
        cloudApi<PlaceReceipt>('/site-photos/location', 'POST', { location: loc }),
      );
      if (!freshPlace(p)) throw Error('地点识别未确认，请重试');
      if (!active.current || session !== generation.current) throw Error('拍摄已结束');
      receipt.current = p;
      setPlace(p);
      setLocationValid(true);
      return p;
    })();
    placeFlight.current = work;
    try {
      return await work;
    } catch (e) {
      if (active.current && session === generation.current) {
        receipt.current = null;
        setLocationValid(false);
      }
      throw e;
    } finally {
      if (placeFlight.current === work) placeFlight.current = null;
    }
  }
  async function start() {
    if (shutterBusy.current || stream.current?.active) return;
    const token = ++generation.current;
    startedAt.current = performance.now();
    readyMeasured.current = false;
    stop();
    receipt.current = null;
    placeFlight.current = null;
    setPlace(null);
    setLocationValid(false);
    setPreviewReady(false);
    setCount(0);
    setPhase('starting');
    setStatus('正在定位并识别小区…');
    preparePhotoRenderer();
    if (navigator.permissions?.query)
      void photoStage('camera-permission-check', async () => {
        try {
          await navigator.permissions.query({ name: 'camera' as PermissionName });
        } catch {
          /* Safari may not expose camera permission querying. */
        }
      });
    const live = () => active.current && token === generation.current;
    const located = ensurePlace()
      .then(() => {
        if (live()) setStatus('');
      })
      .catch((e) => {
        if (live()) {
          generation.current++;
          stop();
          setPhase('error');
          setStatus(e instanceof Error ? e.message : String(e));
        }
      });
    const opened = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (live()) setPhase('native');
        return;
      }
      try {
        const camera = await photoStage('camera-initialize', () =>
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 4096 },
              height: { ideal: 3072 },
            },
          }),
        );
        if (!live()) {
          camera.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = camera;
        const s = camera.getVideoTracks()[0].getSettings();
        setPixels(s.width && s.height ? `${s.width}×${s.height}` : '');
        setPhase('camera');
      } catch {
        if (live()) {
          setStatus('网页相机不可用，请打开系统相机拍摄');
          setPhase('native');
        }
      }
    })();
    await Promise.all([located, opened]);
  }
  useEffect(() => {
    if (phase !== 'camera' && phase !== 'native') return;
    const tick = () => setLocationValid(freshPlace(receipt.current));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, place]);
  functions.current.start = start;
  function finishWatermark(p: LocalPhoto): Promise<void> {
    const old = watermarkJobs.get(p.input.requestId);
    if (old) return old;
    const work = renderSavedPhoto(p).finally(() => watermarkJobs.delete(p.input.requestId));
    watermarkJobs.set(p.input.requestId, work);
    return work;
  }
  async function backgroundWatermark(p: LocalPhoto) {
    try {
      await finishWatermark(p);
    } catch (e) {
      try {
        await updateLocalPhoto(p.owner, p.input.requestId, {
          message: `原图已保留，水印待重试：${String(e)}`,
        });
      } catch {
        /* Raw original already committed; never remove it. */
      }
      if (active.current) setStatus('水印生成失败，原图已保存到应用本地，可重试');
    }
  }
  async function renderSavedPhoto(p: LocalPhoto) {
    const current = await localPhoto(p.owner, p.input.requestId);
    if (!current || current.state !== 'captured') return;
    if (['live-camera', 'native-camera'].includes(p.meta.captureSource) && !p.meta.placeToken)
      throw Error('本次拍摄缺少有效定位，原图保留，请重新拍摄');
    const file = new File([await imageBlob(p.original)], p.input.originalName, {
      type: p.original.type || 'image/jpeg',
    });
    const result = await renderPhoto(file, p.meta);
    const latest = await localPhoto(p.owner, p.input.requestId);
    // A project association may have changed while this image was processing.
    const meta = {
      ...result.meta,
      projectId: latest?.meta.projectId ?? result.meta.projectId,
      projectName: latest?.meta.projectName ?? result.meta.projectName,
    };
    await updateLocalPhoto(p.owner, p.input.requestId, {
      meta,
      input: request(meta),
      watermarked: result.blob,
      thumbnail: result.thumbnail,
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
      return false;
    }
    void backgroundWatermark(photo);
    return true;
  }
  async function capture() {
    if (shutterBusy.current || unsaved || !previewReady) return;
    shutterBusy.current = true;
    setBusy(true);
    const shotAt = performance.now();
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
      if (await persist(blob, p, 'live-camera', at)) {
        photoTiming('shutter-local', shotAt);
        photoTiming('shutter-ready', shotAt);
      }
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
        !freshPlace(p, Math.max(Date.parse(at), Date.parse(p.location.obtainedAt))) ||
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
    await updateLocalPhoto(p.owner, p.input.requestId, {
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
      {(phase === 'camera' || phase === 'native') && !locationValid && (
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
          disabled={!locationValid || busy || !!unsaved}
          onClick={() => {
            if (freshPlace(receipt.current)) {
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
            disabled={phase !== 'camera' || busy || !!unsaved || !locationValid || !previewReady}
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
                  void backgroundWatermark(unsaved);
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
