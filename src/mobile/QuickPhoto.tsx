import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { photoZip, type ZipArchive } from '../lib/photo-zip';
import { shareFailure, validPhotoFiles } from '../lib/photo-share';
import { holdFrameEncoder, encodeVideoFrame } from '../lib/photo-frame';
import { photoTiming, photoStage } from '../lib/photo-performance';
import type { CloudUser } from '../lib/cloud';
import { cloudApi, CloudError } from '../lib/cloud';
import {
  batchSummaries,
  getBatch,
  summarizeBatch,
  putBatch,
  confirmBatch,
  type BatchPhoto,
  type BatchSummary,
} from '../lib/photo-batch';
import { freshPlace, nearbyMapPlace, type PlaceReceipt } from '../lib/photo-location';
import { renderPhoto, holdPhotoRenderer } from '../lib/photo-render';
import { exifCapture } from '../lib/photo-exif';
import { photoTime } from '../lib/site-photo';
import { LiveWatermark } from './LiveWatermark';
import { imageDataUrl } from '../lib/photo-image';
import { NearbyAddress, renewPlace } from './NearbyAddress';
export function QuickPhoto({
  user,
  onSessionChange,
  onReturn,
}: {
  user: CloudUser;
  onSessionChange: (v: boolean) => void;
  onReturn: () => void;
}) {
  const [phase, setPhase] = useState<
      'loading' | 'address' | 'starting' | 'native' | 'camera' | 'done'
    >('loading'),
    [place, setPlace] = useState<PlaceReceipt | null>(null),
    [rows, setRows] = useState<BatchSummary[]>([]),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [processing, setProcessing] = useState(0),
    [shared, setShared] = useState<string[]>([]),
    [preview, setPreview] = useState(''),
    [exportIndex, setExportIndex] = useState(0),
    [ready, setReady] = useState(false),
    [flash, setFlash] = useState(false),
    [, setFilesVersion] = useState(0),
    [saveFallback, setSaveFallback] = useState(false),
    [storageFailed, setStorageFailed] = useState(false),
    [locationBlocked, setLocationBlocked] = useState(false),
    [sharing, setSharing] = useState(false),
    [zipBusy, setZipBusy] = useState(false),
    [zipUrl, setZipUrl] = useState(''),
    [zipName, setZipName] = useState(''),
    [zipProgress, setZipProgress] = useState('');
  const owner = { id: user.id, workspaceId: user.workspaceId },
    video = useRef<HTMLVideoElement>(null),
    input = useRef<HTMLInputElement>(null),
    stream = useRef<MediaStream | null>(null),
    alive = useRef(true),
    locked = useRef(false),
    volatile = useRef(new Map<string, BatchPhoto>()),
    pending = useRef(0),
    actor = useRef(user.displayName || user.login),
    placeRef = useRef(place),
    rowsRef = useRef(rows),
    shown = useRef<string[]>([]),
    files = useRef(new Map<string, File>()),
    session = useRef(0),
    cameraStarted = useRef(0),
    preparing = useRef(false),
    locationFlight = useRef<Promise<PlaceReceipt> | null>(null),
    captureCanvas = useRef<HTMLCanvasElement | null>(null),
    spaceCheck = useRef({ at: 0, free: Infinity }),
    nativeStill = useRef<any>(null),
    shareFlight = useRef(false),
    zipFlight = useRef(false),
    archive = useRef<ZipArchive | null>(null),
    zipLink = useRef(''),
    exportDetails = useRef<Record<string, unknown>>({}),
    archiveCleanups = useRef<{ ids: string[]; cleanup: () => Promise<void> }[]>([]),
    confirmedIds = useRef(new Set<string>());
  const FILE_BUDGET = 64 * 1024 * 1024;
  function cacheFile(row: BatchPhoto) {
    const started = performance.now();
    if (!row.output || files.current.has(row.meta.requestId)) return;
    const bytes = new Uint8Array(row.output);
    if (bytes[0] !== 255 || bytes[1] !== 216) {
      setStatus('JPEG照片内容异常，未发起分享，资料仍保留');
      return;
    }
    const total = [...files.current.values()].reduce((n, f) => n + f.size, 0);
    if (total + row.output.byteLength > FILE_BUDGET && files.current.size) return;
    files.current.set(
      row.meta.requestId,
      new File([row.output], row.meta.originalName, { type: row.mime || 'image/jpeg' }),
    );
    photoTiming('file-prepare', started);
    if (alive.current) setFilesVersion((n) => n + 1);
  }
  async function prepareFiles(items = rowsRef.current) {
    if (preparing.current) return;
    preparing.current = true;
    const started = performance.now();
    try {
      for (const item of items) {
        if (!alive.current) break;
        if (!item.hasOutput || files.current.has(item.meta.requestId)) continue;
        if (
          [...files.current.values()].reduce((n, f) => n + f.size, 0) + item.outputSize >
            FILE_BUDGET &&
          files.current.size
        )
          break;
        const row = await getBatch(owner, item.meta.requestId);
        if (row && alive.current) cacheFile(row);
      }
    } catch (e) {
      if (alive.current) setStatus(String(e));
    } finally {
      preparing.current = false;
      photoTiming('batch-prepare', started);
    }
  }
  placeRef.current = place;
  rowsRef.current = rows;
  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    session.current++;
    nativeStill.current = null;
    if (captureCanvas.current) {
      captureCanvas.current.width = captureCanvas.current.height = 0;
      captureCanvas.current = null;
    }
    setReady(false);
  };
  function accept(row: BatchPhoto) {
    if (alive.current)
      setRows((old) =>
        [...old.filter((p) => p.meta.requestId !== row.meta.requestId), summarizeBatch(row)].sort(
          (a, b) => a.meta.capturedAt.localeCompare(b.meta.capturedAt),
        ),
      );
  }
  async function durable(row: BatchPhoto) {
    volatile.current.set(row.meta.requestId, row);
    accept(row);
    try {
      await photoStage('photo-store', () => putBatch(row));
      volatile.current.delete(row.meta.requestId);
      cacheFile(row);
      if (alive.current && !volatile.current.size) setStorageFailed(false);
    } catch (e) {
      if (alive.current) {
        setStorageFailed(true);
        setStatus('本机暂存失败，照片仍在当前页面，请勿关闭。请重试暂存或导出。');
      }
      throw e;
    }
  }
  async function process(row: BatchPhoto) {
    const started = performance.now();
    pending.current++;
    if (alive.current) setProcessing(pending.current);
    try {
      if (!row.original) throw Error('原始捕获文件不可用');
      if (
        !freshPlace(
          {
            location: row.meta.location!,
            placeName: row.meta.placeName!,
            placeSource: row.meta.placeSource!,
            nearby: !!row.meta.nearby,
            token: row.meta.placeToken!,
            resolvedAt: row.meta.location!.obtainedAt,
            expiresAt: new Date(Date.parse(row.meta.location!.obtainedAt) + 90000).toISOString(),
          },
          Math.max(Date.parse(row.meta.capturedAt), Date.parse(row.meta.location!.obtainedAt)),
        )
      )
        throw Error('拍摄时定位已过期，原始照片已保留，可导出；新照片请重新定位');
      const result = await renderPhoto(
        new File([row.original], row.meta.originalName, { type: row.mime || 'image/jpeg' }),
        row.meta,
        { thumbnail: false, provenance: true },
      );
      const next: BatchPhoto = {
        owner: row.owner,
        meta: {
          ...result.meta,
          outputWidth: result.width,
          outputHeight: result.height,
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
        },
        output: await result.blob.arrayBuffer(),
        mime: result.blob.type,
      };
      await durable(next);
    } catch (e) {
      if (row.original) {
        const failed = { ...row, error: String(e) };
        try {
          await durable(failed);
        } catch {}
      }
    } finally {
      photoTiming('watermark-durable', started);
      pending.current--;
      if (alive.current) setProcessing(pending.current);
    }
  }
  useEffect(() => {
    alive.current = true;
    void batchSummaries(owner)
      .then((items) => {
        if (!alive.current) return;
        setRows(items);
        setPhase(items.length ? 'done' : 'address');
        void prepareFiles(items);
        void (async () => {
          for (const item of items) {
            if (!alive.current) break;
            if (item.hasOriginal && !item.error) {
              const row = await getBatch(owner, item.meta.requestId);
              if (row && alive.current) await process(row);
            }
          }
        })();
      })
      .catch(() => {
        if (alive.current) {
          setPhase('done');
          setStatus('无法读取待保存照片，请勿清除网站数据，稍后重试');
        }
      });
    void cloudApi<{ actorName: string }>('/site-photos/config')
      .then((c) => {
        actor.current = c.actorName;
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      stream.current?.getTracks().forEach((t) => t.stop());
      onSessionChange(false);
      if (zipLink.current) URL.revokeObjectURL(zipLink.current);
    };
  }, [user.id, user.workspaceId]);
  useEffect(() => {
    onSessionChange(['starting', 'camera', 'native', 'address'].includes(phase));
  }, [phase]);
  useEffect(() => {
    if (!['starting', 'camera'].includes(phase)) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [phase]);
  useEffect(() => {
    const block = (e: BeforeUnloadEvent) => {
      if (volatile.current.size) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const click = (e: MouseEvent) => {
      if (
        volatile.current.size &&
        (e.target as Element)?.closest?.('.assistant-header button,.assistant-nav button')
      ) {
        e.preventDefault();
        e.stopPropagation();
        setStatus('请先重试暂存或导出当前未暂存照片');
      }
    };
    window.addEventListener('beforeunload', block);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', block);
      document.removeEventListener('click', click, true);
    };
  }, []);
  useEffect(() => {
    if (phase !== 'camera' || !stream.current || !video.current) return;
    const v = video.current;
    v.srcObject = stream.current;
    void v
      .play()
      .then(() => {
        const frame = () => {
          if (alive.current && video.current === v && stream.current) {
            setReady(true);
            photoTiming('click-preview', cameraStarted.current);
          }
        };
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(frame);
        else requestAnimationFrame(frame);
      })
      .catch(() => setStatus('相机预览失败，可使用系统相机'));
  }, [phase]);
  useEffect(() => {
    if (phase !== 'camera') return;
    const track = stream.current?.getVideoTracks()[0];
    const ended = () => {
      setReady(false);
      setStatus('相机会话已中断，请关闭后重新进入');
    };
    const visible = () => {
      if (document.hidden) setReady(false);
      else if (track?.readyState === 'live' && video.current) {
        void video.current
          .play()
          .then(() => {
            const v = video.current;
            if (!v) return;
            const frame = () => {
              if (alive.current && track.readyState === 'live') setReady(true);
            };
            if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(frame);
            else requestAnimationFrame(frame);
          })
          .catch(ended);
      }
    };
    track?.addEventListener('ended', ended);
    document.addEventListener('visibilitychange', visible);
    return () => {
      track?.removeEventListener('ended', ended);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [phase]);
  async function currentPlace(force = false): Promise<PlaceReceipt> {
    const p = placeRef.current;
    if (!nearbyMapPlace(p)) throw Error('请选择高德地图2公里内的地点');
    if (!force && freshPlace(p)) return p!;
    if (locationFlight.current) return locationFlight.current;
    const generation = session.current;
    const work = (async () => {
      let next: PlaceReceipt;
      try {
        next = await renewPlace(p!);
      } catch (e) {
        if (
          alive.current &&
          generation === session.current &&
          e instanceof CloudError &&
          [400, 403].includes(e.status)
        ) {
          placeRef.current = null;
          setLocationBlocked(true);
        }
        throw e;
      }
      if (!alive.current || generation !== session.current) throw Error('拍摄已结束');
      if (!nearbyMapPlace(next)) {
        placeRef.current = null;
        setLocationBlocked(true);
        throw Error('所选地点不在当前2公里内，请重新选择');
      }
      setPlace(next);
      setLocationBlocked(false);
      placeRef.current = next;
      return next;
    })();
    locationFlight.current = work;
    try {
      return await work;
    } finally {
      if (locationFlight.current === work) locationFlight.current = null;
    }
  }
  useEffect(() => {
    if (!['starting', 'camera'].includes(phase)) return;
    const watermark = holdPhotoRenderer(),
      capture = holdFrameEncoder();
    return () => {
      watermark();
      capture();
    };
  }, [phase]);
  useEffect(() => {
    if (phase !== 'camera') return;
    let live = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      const p = placeRef.current;
      if (p && Date.now() - Date.parse(p.location.obtainedAt) > 45000 && !locationFlight.current)
        void currentPlace(true).catch(() => {
          if (live && !freshPlace(placeRef.current)) setStatus('定位已过期，请重试或重新选择地点');
        });
    }, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [phase]);
  function openNative() {
    setStatus('');
    const p = placeRef.current;
    if (!p || !freshPlace(p)) {
      void currentPlace()
        .then(() => setStatus('定位已更新，请再次点击系统相机'))
        .catch((e) => setStatus(String(e)));
      return;
    }
    stop();
    setPhase('native');
    input.current?.click();
  }
  async function checkSpace() {
    if (!navigator.storage?.estimate) return;
    try {
      const { quota, usage } = await navigator.storage.estimate();
      spaceCheck.current = {
        at: performance.now(),
        free: quota && usage ? quota - usage : Infinity,
      };
    } catch {
      /* Durable writes remain the final storage check. */
    }
  }
  async function liveCamera() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setPhase('starting');
    cameraStarted.current = performance.now();
    void checkSpace();
    const generation = ++session.current;
    try {
      await currentPlace();
      if (!alive.current || generation !== session.current) return;
      const s = await photoStage('camera-initialize', () =>
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 4096 },
            height: { ideal: 3072 },
          },
        }),
      );
      if (!alive.current || generation !== session.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      try {
        const IC = (window as any).ImageCapture;
        nativeStill.current = IC ? new IC(s.getVideoTracks()[0]) : null;
      } catch {
        nativeStill.current = null;
      }
      setPhase('camera');
      setStatus('');
    } catch (e) {
      if (alive.current && generation === session.current) {
        setPhase('done');
        setStatus('无法开启后置相机，请检查相机权限后重试');
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function retain(
    file: File,
    p: PlaceReceipt,
    at: string,
    source: 'live-camera' | 'native-camera',
    captureMethod: 'image-capture' | 'video-frame' | 'native-camera' = 'native-camera',
  ) {
    const row: BatchPhoto = {
      owner,
      meta: {
        requestId: crypto.randomUUID(),
        projectId: '',
        projectName: '',
        capturedAt: at,
        captureSource: source,
        captureMethod,
        originalName: `春茉-${at.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.jpg`,
        originalSize: file.size,
        outputWidth: 1,
        outputHeight: 1,
        location: p.location,
        placeToken: p.token,
        placeName: p.placeName,
        placeSource: p.placeSource,
        nearby: p.nearby,
        ...(p.poi ? { placePoi: p.poi } : {}),
        actorId: user.id,
        actorName: actor.current,
      },
      original: await file.arrayBuffer(),
      mime: file.type,
    };
    try {
      await durable(row);
      void process(row);
    } catch {
      /* Keep the only captured bytes in memory until durable retry/export. */
    }
  }
  async function nativeShot(file?: File) {
    if (!file || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const p = placeRef.current;
      if (!p) throw Error('地址丢失');
      const exif = exifCapture(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
      await retain(file, p, exif?.at || new Date().toISOString(), 'native-camera');
    } catch (e) {
      setStatus(String(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function shoot() {
    if (locked.current || !ready || storageFailed || locationBlocked) return;
    locked.current = true;
    setBusy(true);
    const started = performance.now();
    try {
      while (pending.current >= 2) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (!alive.current || !stream.current) throw Error('相机会话已结束');
      }
      if (!spaceCheck.current.at || performance.now() - spaceCheck.current.at > 10000)
        await checkSpace();
      if (spaceCheck.current.free < 20 * 1024 * 1024)
        throw Error('本机空间不足，请先完成保存后再继续拍摄');
      const p = await currentPlace();
      const track = stream.current?.getVideoTracks()[0],
        v = video.current;
      if (!track || track.readyState !== 'live' || !v || v.readyState < 2)
        throw Error('相机已关闭或画面未就绪');
      let at = new Date().toISOString();
      let blob: Blob | undefined;
      if (nativeStill.current)
        try {
          blob = await photoStage('native-still', () => nativeStill.current.takePhoto());
        } catch (e) {
          if ((e as DOMException)?.name === 'NotSupportedError') nativeStill.current = null;
        }
      const method = blob ? 'image-capture' : 'video-frame';
      if (!blob) {
        const frame = await encodeVideoFrame(
          v,
          (captureCanvas.current ||= document.createElement('canvas')),
        );
        blob = frame.blob;
        at = frame.capturedAt;
      }
      photoTiming('capture', started, { method });
      setFlash(true);
      setTimeout(() => {
        if (alive.current) setFlash(false);
      }, 120);
      await retain(
        new File([blob], `春茉-${at.replaceAll(':', '-')}.jpg`, { type: blob.type }),
        p,
        at,
        'live-camera',
        method,
      );
      photoTiming('shutter-local', started);
    } catch (e) {
      setStatus(String(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const outputs = rows.filter((r) => r.hasOutput),
    failures = rows.filter((r) => r.error);
  function failShare(error: unknown) {
    exportDetails.current.error = shareFailure(error).code;
    setSaveFallback(true);
    setStatus(shareFailure(error).message);
  }
  async function invokeShare(batchFiles: File[], ids: string[]) {
    if (shareFlight.current) {
      setSaveFallback(true);
      setStatus('系统分享尚未返回，可改用ZIP下载；照片仍保留');
      return;
    }
    if (!validPhotoFiles(batchFiles)) {
      setSaveFallback(true);
      setStatus('照片文件尚未准备好，或JPEG文件名、MIME、大小异常；请重试准备或使用ZIP');
      return;
    }
    setStatus(`正在打开系统分享（${ids.length}张照片）…`);
    exportDetails.current = {
      browser: navigator.userAgent,
      secureContext: window.isSecureContext,
      userActivation: navigator.userActivation?.isActive,
      count: batchFiles.length,
      bytes: batchFiles.reduce((n, f) => n + f.size, 0),
      mimes: [...new Set(batchFiles.map((f) => f.type))],
      fileShareAPI: typeof navigator.share === 'function',
      canShare: 'checking',
      recentPerformance: performance
        .getEntriesByType('measure')
        .filter((e) => e.name.startsWith('chunmo-photo:'))
        .slice(-30)
        .map((e) => ({ stage: e.name, ms: Math.round(e.duration) })),
    };
    try {
      const supported = !!navigator.share && !!navigator.canShare?.({ files: batchFiles });
      exportDetails.current.canShare = supported;
      if (!supported) {
        setSaveFallback(true);
        setStatus(
          '当前浏览器不支持此批图片分享，请下载ZIP到文件目录，或单张分享；ZIP不等于存入相册',
        );
        void buildZip();
        return;
      }
      shareFlight.current = true;
      setSharing(true);
      const at = performance.now();
      // No asynchronous preparation before this call: it stays inside the real user gesture.
      const gesture = navigator.userActivation?.isActive;
      const work = navigator.share({ files: batchFiles, title: '春茉设计' });
      photoTiming('share-invoke', at, {
        count: ids.length,
        active: gesture ? 'yes' : 'no',
      });
      const notice = setTimeout(() => {
        if (alive.current) {
          setSaveFallback(true);
          setStatus(
            '系统分享长时间未返回，可改用ZIP下载。照片仍保留；请先关闭可能打开的系统面板。',
          );
        }
      }, 12000);
      try {
        await work;
        if (alive.current) {
          setShared(ids);
          setStatus(
            `系统分享已返回（${ids.length}张），不代表已存入相册。请在目标位置确认，副本仍保留。`,
          );
        }
      } finally {
        clearTimeout(notice);
        photoTiming('share-return', at);
      }
    } catch (e) {
      if (alive.current) {
        failShare(e);
        if (!(e instanceof Error) || e.name !== 'AbortError') void buildZip();
      }
    } finally {
      shareFlight.current = false;
      if (alive.current) setSharing(false);
    }
  }
  async function share(partial = false) {
    const wanted = partial ? outputs.slice(0, 5) : outputs;
    if (processing || rows.some((r) => !r.hasOutput)) {
      setStatus(`正在准备照片 ${outputs.length}/${rows.length}`);
      return;
    }
    const chosen = wanted.filter((row) => files.current.has(row.meta.requestId));
    if (chosen.length !== wanted.length || !chosen.length) {
      setStatus('正在准备照片文件；大批次可使用完整ZIP导出。文件准备后请再次点击保存。');
      setSaveFallback(true);
      void prepareFiles().then(() => {
        if (alive.current) setStatus('文件准备已更新，请点击保存或使用完整ZIP导出');
      });
      if (outputs.reduce((n, r) => n + r.outputSize, 0) > FILE_BUDGET) void buildZip();
      return;
    }
    await invokeShare(
      chosen.map((r) => files.current.get(r.meta.requestId)!),
      chosen.map((r) => r.meta.requestId),
    );
  }
  async function buildZip(partial = false) {
    if (zipFlight.current) return;
    if (processing || rows.some((r) => !r.hasOutput) || !outputs.length) {
      setStatus(`正在准备照片 ${outputs.length}/${rows.length}，处理完成后才能打包`);
      return;
    }
    zipFlight.current = true;
    files.current.clear();
    setFilesVersion((n) => n + 1);
    setZipBusy(true);
    setSaveFallback(true);
    setZipProgress('正在打包照片 0/' + outputs.length);
    try {
      let selected = outputs;
      if (partial) {
        selected = [];
        let size = 0;
        for (const row of outputs) {
          if (
            selected.length >= 5 ||
            (selected.length && size + row.outputSize + 1024 > 16 * 1024 * 1024)
          )
            break;
          selected.push(row);
          size += row.outputSize + 1024;
        }
        if (selected.reduce((n, r) => n + r.outputSize + 1024, 0) > FILE_BUDGET)
          throw Error('单张照片过大，请用单张分享或支持流式ZIP的浏览器');
      }
      if (
        archive.current &&
        selected.map((r) => r.meta.requestId).join('|') === archive.current.ids.join('|')
      ) {
        setZipProgress(`已准备${selected.length}张ZIP，可直接点击下载；ZIP不等于存入相册`);
        return;
      }
      const now = new Date();
      const stamp =
        photoTime(now.toISOString()).replace(/[. :]/g, '-') +
        '-' +
        String(now.getUTCSeconds()).padStart(2, '0');
      const name = `春茉照片-${stamp}-${selected.length}张.zip`;
      const result = await photoZip(
        selected.map((r) => ({
          id: r.meta.requestId,
          name: r.meta.originalName,
          size: r.outputSize,
          at: r.meta.capturedAt,
        })),
        async (id) => {
          const row = await getBatch(owner, id);
          if (!row?.output) throw Error('水印照片尚未就绪');
          if (alive.current && !files.current.size) cacheFile(row);
          return row.output;
        },
        name,
        JSON.stringify(owner),
        (n, total) => {
          if (alive.current) setZipProgress(`正在打包照片 ${n}/${total}`);
        },
      );
      if (!alive.current) {
        await result.cleanup();
        return;
      }
      if (zipLink.current) URL.revokeObjectURL(zipLink.current);
      // This archive is a derived export; the original temporary photo records remain intact.
      archive.current = result;
      exportDetails.current.zipStorage = result.storage;
      exportDetails.current.zipBytes = result.file.size;
      archiveCleanups.current.push({ ids: result.ids, cleanup: result.cleanup });
      zipLink.current = URL.createObjectURL(result.file);
      setZipUrl(zipLink.current);
      setZipName(result.file.name);
      setZipProgress(`已打包${result.ids.length}张，点击下载ZIP到文件目录；ZIP不等于存入系统相册`);
    } catch (e) {
      if (alive.current) {
        setZipProgress('');
        setStatus(
          `ZIP准备失败：${e instanceof Error ? e.message : String(e)}。照片未删除，可重试、分批ZIP或单张分享。`,
        );
      }
    } finally {
      zipFlight.current = false;
      if (alive.current) setZipBusy(false);
    }
  }
  function shareOne() {
    const info = outputs[exportIndex] || outputs[0];
    if (!info) {
      setStatus('没有可分享的水印照片');
      return;
    }
    const file = files.current.get(info.meta.requestId);
    if (!file) {
      setStatus('正在准备单张文件，请再次点击单张分享');
      void getBatch(owner, info.meta.requestId)
        .then((row) => {
          if (row && alive.current) {
            files.current.clear();
            cacheFile(row);
          }
        })
        .catch((e) => setStatus(String(e)));
      return;
    }
    void invokeShare([file], [info.meta.requestId]);
  }
  async function exportOne(index: number) {
    const info = rows[index];
    if (!info) return;
    try {
      const row =
        volatile.current.get(info.meta.requestId) || (await getBatch(owner, info.meta.requestId));
      if (!row) throw Error('照片暂不可用');
      const bytes = row.output || row.original;
      if (!bytes) throw Error('照片暂不可用');
      setPreview(await imageDataUrl(new Blob([bytes], { type: row.mime || 'image/jpeg' })));
      setExportIndex(index);
      shown.current = [...new Set([...shown.current, ...(row.output ? [row.meta.requestId] : [])])];
      setStatus(
        row.output
          ? '长按图片选择保存/下载图片，请到相册或下载目录确认后再清理副本'
          : '这是处理失败时保留的原始捕获文件，尚未加水印；请先导出保管',
      );
    } catch (e) {
      setStatus(String(e));
    }
  }
  async function cleanup() {
    const ids = [...new Set([...shared, ...shown.current])];
    try {
      await confirmBatch(owner, ids);
      setRows((old) => old.filter((p) => !ids.includes(p.meta.requestId)));
      for (const id of ids) files.current.delete(id);
      void prepareFiles(rowsRef.current.filter((row) => !ids.includes(row.meta.requestId)));
      for (const id of ids) confirmedIds.current.add(id);
      archiveCleanups.current = archiveCleanups.current.filter((record) => {
        if (record.ids.every((id) => confirmedIds.current.has(id))) {
          void record.cleanup();
          return false;
        }
        return true;
      });
      if (archive.current?.ids.every((id) => confirmedIds.current.has(id))) {
        archive.current = null;
        if (zipLink.current) URL.revokeObjectURL(zipLink.current);
        zipLink.current = '';
        setZipUrl('');
        setZipName('');
      }
      setShared([]);
      shown.current = [];
      setPreview('');
      setStatus('已按你的确认清理对应副本');
      if (rowsRef.current.every((p) => ids.includes(p.meta.requestId))) onReturn();
    } catch (e) {
      setStatus(String(e));
    }
  }
  return (
    <section className="quick-photo">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label="系统相机照片"
        onChange={(e) => {
          void nativeShot(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {phase === 'address' && (
        <NearbyAddress
          onCancel={onReturn}
          onConfirm={(p) => {
            setPlace(p);
            placeRef.current = p;
            setLocationBlocked(false);
            void liveCamera();
          }}
        />
      )}
      {phase === 'loading' && <p>正在读取待保存照片…</p>}
      {['starting', 'camera'].includes(phase) &&
        createPortal(
          <section
            className={`photo-immersive ${flash ? 'shutter-feedback' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label="连续拍摄相机"
          >
            <div className="immersive-viewfinder">
              <video ref={video} autoPlay muted playsInline aria-label="后置相机实时预览" />
              <LiveWatermark place={place?.placeName} actor={actor.current} />
            </div>
            <header className="immersive-top">
              <button
                aria-label="关闭相机"
                disabled={busy && phase !== 'starting'}
                onClick={() => {
                  stop();
                  setPhase('done');
                  if (!rowsRef.current.length && !volatile.current.size) onReturn();
                }}
              >
                ×
              </button>
              <strong>{place?.placeName}</strong>
            </header>
            <footer className="quick-camera-controls immersive-bottom">
              <span aria-live="polite">已拍 {rows.length} 张</span>
              <button
                className="camera-shutter"
                aria-label="拍照"
                disabled={busy || !ready || processing >= 2 || storageFailed || locationBlocked}
                onClick={() => void shoot()}
              >
                <span />
              </button>
              <button
                disabled={busy || !rows.length}
                onClick={() => {
                  stop();
                  setPhase('done');
                  void prepareFiles();
                }}
              >
                完成拍摄
              </button>
            </footer>
            {(phase === 'starting' || status) && (
              <p role="status" className="immersive-status">
                {phase === 'starting' ? '正在开启相机…' : status}
              </p>
            )}
            {storageFailed && (
              <button
                className="immersive-recovery"
                onClick={() => {
                  stop();
                  setPhase('done');
                }}
              >
                照片未可靠暂存，前往恢复
              </button>
            )}
            {failures.length > 0 && (
              <button
                className="immersive-recovery"
                onClick={() => {
                  stop();
                  setPhase('done');
                }}
              >
                有照片处理失败，前往恢复
              </button>
            )}
          </section>,
          document.body,
        )}
      {phase === 'native' && (
        <div className="photo-batch-summary">
          <p>{place?.placeName}</p>
          <button disabled={busy} onClick={openNative}>
            继续拍摄
          </button>
          <button
            disabled={busy}
            onClick={() => {
              stop();
              setPhase('done');
            }}
          >
            完成拍摄
          </button>
        </div>
      )}
      {phase === 'done' && (
        <div className="photo-batch-summary">
          <h2>本次照片 {rows.length} 张</h2>
          {(processing > 0 || rows.some((r) => r.hasOriginal && !r.error)) && (
            <p role="status">
              正在准备照片 {outputs.length}/{rows.length}
            </p>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              sharing ||
              zipBusy ||
              processing > 0 ||
              rows.some((r) => !r.hasOutput) ||
              !outputs.length ||
              storageFailed
            }
            onClick={() => void share()}
          >
            {sharing ? '系统分享中…' : `保存${outputs.length}张照片`}
          </button>
          <details
            className="photo-save-options"
            open={saveFallback}
            onToggle={(e) => setSaveFallback(e.currentTarget.open)}
          >
            <summary>更多保存方式</summary>
            <details>
              <summary>保存问题详情</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>
                {JSON.stringify(exportDetails.current, null, 2)}
              </pre>
            </details>
            <button
              disabled={zipBusy || processing > 0 || !outputs.length}
              onClick={() => void buildZip()}
            >
              重新打包完整ZIP
            </button>
            <button
              disabled={zipBusy || processing > 0 || !outputs.length}
              onClick={() => void buildZip(true)}
            >
              分批ZIP（最多5张）
            </button>
            <button
              disabled={sharing || zipBusy || processing > 0 || !outputs.length}
              onClick={shareOne}
            >
              单张分享
            </button>
            {outputs.length > 1 && (
              <button disabled={busy || processing > 0} onClick={() => void share(true)}>
                分批分享（最多5张）
              </button>
            )}
            {rows.length > 0 && (
              <button onClick={() => void exportOne(0)}>分享不可用，逐张导出</button>
            )}
          </details>
          {(shared.length > 0 || shown.current.length > 0) && (
            <button disabled={busy || storageFailed} onClick={() => void cleanup()}>
              已确认导出，清理副本
            </button>
          )}
          <button onClick={onReturn} disabled={storageFailed}>
            返回管理页面
          </button>
          {!rows.length && <button onClick={() => setPhase('address')}>重新选择地址</button>}
          {!rows.length && place && (
            <button disabled={busy} onClick={() => void liveCamera()}>
              重试开启相机
            </button>
          )}
          {!rows.length && place && <button onClick={openNative}>兼容模式：系统相机</button>}
        </div>
      )}
      {status && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
      {zipProgress && <p role="status">{zipProgress}</p>}
      {zipUrl && (
        <a
          className="photo-zip-download"
          href={zipUrl}
          download={zipName}
          onClick={() => {
            if (archive.current) {
              setShared(archive.current.ids);
              setStatus(
                `已请求下载：${zipName}，包含${archive.current.ids.length}张照片。请到下载/文件目录确认；这不代表已存入系统相册。`,
              );
            }
          }}
        >
          下载 {zipName}
        </a>
      )}
      {failures.length > 0 && (
        <button
          disabled={processing > 0}
          onClick={() => {
            void (async () => {
              for (const info of failures) {
                const row = await getBatch(owner, info.meta.requestId);
                if (row) await process(row);
              }
            })();
          }}
        >
          重试水印处理（{failures.length}张）
        </button>
      )}
      {storageFailed && (
        <button
          onClick={() => {
            for (const row of volatile.current.values())
              void durable(row)
                .then(() => {
                  if (row.original) void process(row);
                })
                .catch(() => {});
          }}
        >
          重试本机暂存
        </button>
      )}
      {preview && (
        <div className="photo-export">
          <img src={preview} alt="本次照片导出" />
          {rows.length > 1 && (
            <>
              <button disabled={exportIndex === 0} onClick={() => void exportOne(exportIndex - 1)}>
                上一张
              </button>
              <button
                disabled={exportIndex >= rows.length - 1}
                onClick={() => void exportOne(exportIndex + 1)}
              >
                下一张
              </button>
            </>
          )}
          <button onClick={() => setPreview('')}>关闭导出</button>
        </div>
      )}
    </section>
  );
}
