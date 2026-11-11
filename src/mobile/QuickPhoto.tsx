import { useEffect, useRef, useState } from 'react';
import type { CloudUser } from '../lib/cloud';
import { cloudApi } from '../lib/cloud';
import { batchPhotos, putBatch, confirmBatch, type BatchPhoto } from '../lib/photo-batch';
import { freshPlace, type PlaceReceipt } from '../lib/photo-location';
import { renderPhoto } from '../lib/photo-render';
import { exifCapture } from '../lib/photo-exif';
import { photoTime } from '../lib/site-photo';
import { imageDataUrl } from '../lib/photo-image';
import { photoMetadata } from '../lib/photo-metadata';
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
  const [phase, setPhase] = useState<'loading' | 'address' | 'native' | 'camera' | 'done'>(
      'loading',
    ),
    [place, setPlace] = useState<PlaceReceipt | null>(null),
    [rows, setRows] = useState<BatchPhoto[]>([]),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [processing, setProcessing] = useState(0),
    [clock, setClock] = useState(new Date().toISOString()),
    [shared, setShared] = useState<string[]>([]),
    [preview, setPreview] = useState(''),
    [exportIndex, setExportIndex] = useState(0),
    [ready, setReady] = useState(false),
    [aspect, setAspect] = useState(0.75);
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
    shown = useRef<string[]>([]);
  placeRef.current = place;
  rowsRef.current = rows;
  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setReady(false);
  };
  function accept(row: BatchPhoto) {
    if (alive.current)
      setRows((old) =>
        [...old.filter((p) => p.meta.requestId !== row.meta.requestId), row].sort((a, b) =>
          a.meta.capturedAt.localeCompare(b.meta.capturedAt),
        ),
      );
  }
  async function durable(row: BatchPhoto) {
    volatile.current.set(row.meta.requestId, row);
    accept(row);
    try {
      await putBatch(row);
      volatile.current.delete(row.meta.requestId);
    } catch (e) {
      if (alive.current) setStatus('本机暂存失败，照片仍在当前页面，请勿关闭。请重试暂存或导出。');
      throw e;
    }
  }
  async function process(row: BatchPhoto) {
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
      );
      const next: BatchPhoto = {
        owner: row.owner,
        meta: { ...result.meta, outputWidth: result.width, outputHeight: result.height },
        output: await (await photoMetadata(result.blob, result.meta)).arrayBuffer(),
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
      pending.current--;
      if (alive.current) setProcessing(pending.current);
    }
  }
  useEffect(() => {
    alive.current = true;
    void batchPhotos(owner)
      .then((items) => {
        if (!alive.current) return;
        setRows(items);
        setPhase(items.length ? 'done' : 'address');
        for (const p of items) if (p.original && !p.error) void process(p);
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
    };
  }, [user.id, user.workspaceId]);
  useEffect(() => {
    onSessionChange(['camera', 'native', 'address'].includes(phase));
  }, [phase]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, []);
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
        if (alive.current) setReady(true);
      })
      .catch(() => setStatus('相机预览失败，可使用系统相机'));
  }, [phase]);
  async function currentPlace() {
    const p = placeRef.current;
    if (!p) throw Error('请先选择地址');
    if (freshPlace(p, Date.now(), 30000)) return p;
    const next = await renewPlace(p);
    if (!alive.current) throw Error('拍摄已结束');
    setPlace(next);
    placeRef.current = next;
    return next;
  }
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
  async function liveCamera() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await currentPlace();
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 4096 },
          height: { ideal: 3072 },
        },
      });
      if (!alive.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      setPhase('camera');
      setStatus('');
    } catch (e) {
      setStatus(String(e));
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
  ) {
    const row: BatchPhoto = {
      owner,
      meta: {
        requestId: crypto.randomUUID(),
        projectId: '',
        projectName: '',
        capturedAt: at,
        captureSource: source,
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
    if (locked.current || !ready) return;
    locked.current = true;
    setBusy(true);
    try {
      const p = await currentPlace();
      const track = stream.current?.getVideoTracks()[0],
        v = video.current;
      if (!track || !v) throw Error('相机已关闭');
      const at = new Date().toISOString();
      let blob: Blob | undefined;
      const IC = (window as any).ImageCapture;
      if (IC)
        try {
          blob = await new IC(track).takePhoto();
        } catch {}
      if (!blob) {
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        if (!ctx || !c.width) throw Error('相机画面未就绪');
        ctx.drawImage(v, 0, 0);
        blob = await new Promise<Blob>((resolve, reject) =>
          c.toBlob((b) => (b ? resolve(b) : reject(Error('拍照失败'))), 'image/jpeg', 0.98),
        );
        c.width = c.height = 0;
      }
      await retain(
        new File([blob], `春茉-${at.replaceAll(':', '-')}.jpg`, { type: blob.type }),
        p,
        at,
        'live-camera',
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const outputs = rows.filter((r) => r.output),
    failures = rows.filter((r) => r.error);
  async function share(partial = false) {
    const chosen = partial ? outputs.slice(0, 5) : outputs;
    const files = chosen.map(
      (r) => new File([r.output!], r.meta.originalName, { type: r.mime || 'image/jpeg' }),
    );
    try {
      if (!files.length) throw Error('照片仍在处理');
      if (!navigator.share || !navigator.canShare?.({ files })) {
        setStatus('当前浏览器不支持此批图片分享，可尝试分批分享或逐张导出');
        return;
      }
      setBusy(true);
      await navigator.share({ files, title: '春茉设计' });
      if (alive.current) {
        setShared(chosen.map((r) => r.meta.requestId));
        setStatus('已交给系统分享。请确认相册中已存储这些照片，副本仍保留。');
      }
    } catch (e) {
      if (alive.current) setStatus('未确认保存，照片已保留，可重试、分批分享或导出。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function exportOne(index: number) {
    const row = rows[index];
    if (!row) return;
    try {
      const bytes = row.output || row.original;
      if (!bytes) throw Error('照片暂不可用');
      setPreview(await imageDataUrl(new Blob([bytes], { type: row.mime || 'image/jpeg' })));
      setExportIndex(index);
      shown.current = [...new Set([...shown.current, ...(row.output ? [row.meta.requestId] : [])])];
      setStatus(
        row.output
          ? '长按图片选择“存储图像”，保存后确认清理副本'
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
            openNative();
          }}
        />
      )}
      {phase === 'loading' && <p>正在读取待保存照片…</p>}
      {(phase === 'camera' || phase === 'native') && (
        <>
          <div
            className="quick-camera"
            style={
              phase === 'camera'
                ? { width: `min(100%, ${65 * aspect}dvh)`, marginInline: 'auto' }
                : undefined
            }
          >
            {phase === 'camera' && (
              <>
                <video
                  ref={video}
                  autoPlay
                  muted
                  playsInline
                  aria-label="后置相机实时预览"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                  }}
                />
                <div className="live-watermark" aria-label="实时水印">
                  <div>
                    <img src="/brand/source/chunmo-original.jpg" alt="春茉原始Logo" />
                    春茉设计
                  </div>
                  <span>工地定位：{place?.placeName}</span>
                  <span>拍摄时间：{photoTime(clock)}</span>
                  <span>拍摄人员：{actor.current}</span>
                </div>
              </>
            )}
            {phase === 'native' && <p>{place?.placeName}</p>}
          </div>
          <div className="quick-camera-controls">
            <span>已拍 {rows.length} 张</span>
            {phase === 'native' ? (
              <>
                <button className="primary" disabled={busy} onClick={openNative}>
                  继续拍摄
                </button>
                <button disabled={busy} onClick={() => void liveCamera()}>
                  网页连续拍摄
                </button>
              </>
            ) : (
              <>
                <button
                  className="primary camera-shutter"
                  disabled={busy || !ready || !!volatile.current.size}
                  onClick={() => void shoot()}
                >
                  拍照
                </button>
                <button disabled={busy} onClick={openNative}>
                  系统相机
                </button>
              </>
            )}
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
        </>
      )}
      {phase === 'done' && (
        <div className="photo-batch-summary">
          <h2>本次照片 {rows.length} 张</h2>
          {processing > 0 && <p role="status">正在加水印 {processing} 张</p>}
          <button
            className="primary"
            disabled={busy || processing > 0 || !outputs.length}
            onClick={() => void share()}
          >
            保存本次照片
          </button>
          {outputs.length > 1 && (
            <button disabled={busy || processing > 0} onClick={() => void share(true)}>
              分批分享（最多5张）
            </button>
          )}
          {rows.length > 0 && (
            <button onClick={() => void exportOne(0)}>分享不可用，逐张导出</button>
          )}
          {(shared.length > 0 || shown.current.length > 0) && (
            <button disabled={busy || !!volatile.current.size} onClick={() => void cleanup()}>
              已确认存入相册，清理对应副本
            </button>
          )}
          <button onClick={onReturn} disabled={!!volatile.current.size}>
            返回管理页面
          </button>
          {!rows.length && <button onClick={() => setPhase('address')}>开始拍摄</button>}
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {failures.length > 0 && (
        <button
          disabled={processing > 0}
          onClick={() => {
            for (const row of failures) void process(row);
          }}
        >
          重试水印处理（{failures.length}张）
        </button>
      )}
      {volatile.current.size > 0 && (
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
