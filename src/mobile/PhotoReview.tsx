import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Download, Trash2, X } from 'lucide-react';
import { cacheBatchThumbnail, type BatchPhoto, type BatchSummary } from '../lib/photo-batch';
import type { Owner } from '../lib/record-outbox';
import { imageDataUrl } from '../lib/photo-image';
import { renderOutputThumbnail } from '../lib/photo-render';
import { photoTiming } from '../lib/photo-performance';
import { shareFailure, validPhotoFiles } from '../lib/photo-share';

type ReadPhoto = (id: string) => Promise<BatchPhoto | undefined>;
const FILE_BUDGET = 64 * 1024 * 1024;
let thumbnailQueue: Promise<unknown> = Promise.resolve();
function thumbnail(owner: Owner, id: string, read: ReadPhoto, active: () => boolean) {
  const task = thumbnailQueue.then(async () => {
    const started = performance.now();
    if (!active()) return;
    const row = await read(id);
    if (!row || !active()) return;
    if (row.thumbnail) {
      photoTiming('thumbnail-load', started, { cached: 'yes' });
      return row.thumbnail;
    }
    if (!row.output) return;
    const blob = await renderOutputThumbnail(
      new Blob([row.output], { type: row.mime || 'image/jpeg' }),
      row.meta.outputWidth,
      row.meta.outputHeight,
    );
    // A failed preview cache write never blocks saving the original full-resolution file.
    await cacheBatchThumbnail(owner, id, blob).catch(() => {});
    photoTiming('thumbnail-load', started, { cached: 'no' });
    return blob;
  });
  thumbnailQueue = task.catch(() => {});
  return task;
}
const PhotoThumbnail = memo(function PhotoThumbnail({
  ownerId,
  workspaceId,
  id,
  ready,
  index,
  read,
}: {
  ownerId: string;
  workspaceId: string;
  id: string;
  ready: boolean;
  index: number;
  read: ReadPhoto;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [src, setSrc] = useState(''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '160px',
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !ready) return;
    let active = true,
      url = '';
    setFailed(false);
    void thumbnail({ id: ownerId, workspaceId }, id, read, () => active)
      .then((blob) => {
        if (active && blob) {
          url = URL.createObjectURL(blob);
          setSrc(url);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setSrc('');
    };
  }, [visible, ready, ownerId, workspaceId, id, read]);
  return (
    <span ref={host} className="photo-thumbnail">
      {src ? (
        <img src={src} alt={`第${index + 1}张水印照片`} decoding="async" />
      ) : (
        <span>{!ready ? '处理中' : failed ? '缩略图暂不可用' : '正在载入'}</span>
      )}
    </span>
  );
});
function photoFile(row: BatchPhoto, allowOriginal = false) {
  const bytes = row.output || (allowOriginal ? row.original : undefined);
  if (!bytes) throw Error('水印照片尚未准备好，文件仍保留');
  const file = new File([bytes], row.meta.originalName, { type: row.mime || 'image/jpeg' });
  if (
    row.output &&
    (!validPhotoFiles([file]) ||
      new Uint8Array(bytes)[0] !== 255 ||
      new Uint8Array(bytes)[1] !== 216)
  )
    throw Error('水印照片文件异常，未导出，原资料仍保留');
  return file;
}
function iosBrowser() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
export function PhotoReview({
  owner,
  rows,
  processing,
  blocked,
  read,
  onContinue,
  onDelete,
}: {
  owner: Owner;
  rows: BatchSummary[];
  processing: number;
  blocked: boolean;
  read: ReadPhoto;
  onContinue: () => void;
  onDelete: (ids: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState(() => new Set(rows.map((r) => r.meta.requestId)));
  const [preparation, setPreparation] = useState<'preparing' | 'ready' | 'large' | 'error'>(
    'preparing',
  );
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState(''),
    [sharing, setSharing] = useState(false),
    [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<{ file: File; src: string; raw: boolean } | null>(null);
  const known = useRef(new Set(rows.map((r) => r.meta.requestId))),
    files = useRef(new Map<string, File>());
  const alive = useRef(true),
    shareFlight = useRef(false),
    previewVersion = useRef(0);
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const allCheck = useRef<HTMLInputElement>(null);
  const chosen = rows.filter((r) => selected.has(r.meta.requestId));
  const selectedKey = chosen
    .map((r) => `${r.meta.requestId}:${r.hasOutput}:${r.outputSize}`)
    .join('|');
  const rowKey = rows.map((r) => r.meta.requestId).join('|');
  let previewShareable = false;
  try {
    previewShareable =
      !!preview &&
      !preview.raw &&
      typeof navigator.share === 'function' &&
      !!navigator.canShare?.({ files: [preview.file] });
  } catch {
    /* The full image remains available for long-press saving. */
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      previewVersion.current++;
      for (const [url, timer] of downloadUrls.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloadUrls.current.clear();
      files.current.clear();
    };
  }, []);
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.meta.requestId));
    const added = [...ids].filter((id) => !known.current.has(id));
    setSelected((old) => new Set([...old].filter((id) => ids.has(id)).concat(added)));
    known.current = ids;
  }, [rowKey]);
  useEffect(() => {
    if (allCheck.current)
      allCheck.current.indeterminate = chosen.length > 0 && chosen.length < rows.length;
  }, [chosen.length, rows.length]);
  useEffect(() => {
    let active = true;
    const ids = new Set(chosen.map((r) => r.meta.requestId));
    for (const id of files.current.keys()) if (!ids.has(id)) files.current.delete(id);
    if (chosen.reduce((n, r) => n + r.outputSize, 0) > FILE_BUDGET) {
      files.current.clear();
      setPreparation('large');
      return;
    }
    setPreparation('preparing');
    void (async () => {
      const started = performance.now();
      try {
        for (const row of chosen) {
          if (!active) return;
          if (!row.hasOutput || files.current.has(row.meta.requestId)) continue;
          const value = await read(row.meta.requestId);
          if (!active) return;
          if (!value) throw Error('照片暂时无法读取，请保留网站数据后重试');
          files.current.set(row.meta.requestId, photoFile(value));
        }
        if (active) setPreparation('ready');
      } catch (e) {
        if (active) {
          setPreparation('error');
          setNotice(String(e));
        }
      } finally {
        photoTiming('batch-prepare', started);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedKey, read, retry]);
  const toggle = (id: string) =>
    setSelected((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  function requestDownload(file: File) {
    try {
      const link = document.createElement('a'),
        url = URL.createObjectURL(file);
      link.href = url;
      link.download = file.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      downloadUrls.current.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloadUrls.current.delete(url);
        }, 60000),
      );
      setNotice(`已请求下载：${file.name}。请到Downloads/下载目录确认，不代表已存入相册。`);
    } catch (e) {
      void showPreview(file, false, `下载失败：${String(e)}。照片仍保留，可重试或长按图片保存。`);
    }
  }
  async function showPreview(file: File, raw = false, message?: string) {
    if (!alive.current) return;
    const generation = ++previewVersion.current;
    try {
      setNotice(
        message ||
          (raw
            ? '原始捕获文件尚未加水印，请先保管；原文件仍保留。'
            : '长按图片可使用系统保存操作；下载到文件目录不等于存入相册。'),
      );
      const src = await imageDataUrl(file);
      if (alive.current && generation === previewVersion.current) setPreview({ file, src, raw });
    } catch (e) {
      if (alive.current) setNotice(`照片预览失败：${String(e)}。文件仍保留，可重试。`);
    }
  }
  function shareNow(batch: File[], onFailure?: (message: string) => void) {
    if (shareFlight.current) {
      setNotice('系统分享尚未返回，请先关闭原面板；照片仍保留，可逐张下载。');
      return;
    }
    if (!validPhotoFiles(batch)) {
      setNotice('照片文件尚未准备好，请重试；文件仍保留。');
      return;
    }
    shareFlight.current = true;
    setSharing(true);
    setNotice(`正在打开系统分享（${batch.length}张）…`);
    const at = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      shareFlight.current = false;
      if (alive.current) setSharing(false);
    };
    const failed = (e: unknown) => {
      if (!alive.current) return;
      const message = shareFailure(e).message;
      setNotice(message);
      if (!(e instanceof Error) || e.name !== 'AbortError') onFailure?.(message);
    };
    try {
      // Files were prepared before the click. No awaited work before this native API call.
      const work = navigator.share({ files: batch, title: '春茉设计' });
      photoTiming('share-invoke', at, {
        count: batch.length,
        active: navigator.userActivation?.isActive ? 'yes' : 'no',
      });
      timer = setTimeout(() => {
        if (alive.current)
          setNotice('系统分享长时间未返回。请先关闭可能打开的系统面板；照片仍保留，可逐张下载。');
      }, 12000);
      void work
        .then(() => {
          if (alive.current)
            setNotice('系统分享已返回，不代表已存入相册。请在系统相册或目标位置确认，照片仍保留。');
        })
        .catch(failed)
        .finally(() => {
          photoTiming('share-return', at);
          finish();
        });
    } catch (e) {
      failed(e);
      finish();
    }
  }
  function saveSelected() {
    if (!chosen.length) {
      setNotice('请先选择照片');
      return;
    }
    if (preparation === 'error') {
      setNotice('正在重新准备照片，请稍后再次点击保存');
      setRetry((n) => n + 1);
      return;
    }
    if (preparation === 'large') {
      setNotice('选中照片较大，请减少选择，分批保存或逐张保存；照片仍保留。');
      return;
    }
    const batch = chosen.map((r) => files.current.get(r.meta.requestId));
    if (batch.some((f) => !f)) {
      setNotice('照片文件正在准备，请稍后重试或逐张保存。');
      return;
    }
    try {
      if (
        typeof navigator.share !== 'function' ||
        !navigator.canShare?.({ files: batch as File[] })
      ) {
        setNotice('当前浏览器不支持批量保存，请逐张保存。也可减少选择后重试。');
        return;
      }
      shareNow(batch as File[]);
    } catch (e) {
      setNotice(shareFailure(e).message);
    }
  }
  function saveFile(file: File) {
    try {
      if (
        !shareFlight.current &&
        typeof navigator.share === 'function' &&
        navigator.canShare?.({ files: [file] })
      ) {
        shareNow([file], (message) => {
          void showPreview(file, false, message);
        });
        return;
      }
    } catch (e) {
      void showPreview(file, false, shareFailure(e).message);
      return;
    }
    if (!iosBrowser() && 'download' in HTMLAnchorElement.prototype) requestDownload(file);
    else void showPreview(file);
  }
  function saveSingle(id: string) {
    const file = files.current.get(id);
    if (file) {
      saveFile(file);
      return;
    }
    setNotice('正在准备这张照片…');
    void read(id)
      .then((row) => {
        if (!row) throw Error('照片暂时无法读取');
        // A new tap in the preview performs native sharing; never share after an async read.
        return showPreview(photoFile(row, true), !row.output);
      })
      .catch((e) => {
        if (alive.current) setNotice(`照片准备失败：${String(e)}。文件仍保留，请重试。`);
      });
  }
  async function removeSelected() {
    if (
      !chosen.length ||
      !confirm(`确认删除选中的${chosen.length}张本地照片？尚未导出的照片也将删除，请先确认已保管。`)
    )
      return;
    setDeleting(true);
    try {
      await onDelete(chosen.map((r) => r.meta.requestId));
      setNotice('已按你的确认删除选中照片');
    } catch (e) {
      setNotice(`删除失败：${String(e)}，请重试。`);
    } finally {
      if (alive.current) setDeleting(false);
    }
  }
  return (
    <section className="photo-review" aria-label="本次拍摄照片">
      <header className="photo-review-heading">
        <h2>本次照片 {rows.length} 张</h2>
        <label>
          <input
            ref={allCheck}
            type="checkbox"
            aria-label="全选照片"
            checked={rows.length > 0 && chosen.length === rows.length}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(rows.map((r) => r.meta.requestId)) : new Set())
            }
          />
          全选
        </label>
      </header>
      <div className="photo-review-actions">
        <button disabled={blocked || deleting || sharing} onClick={onContinue}>
          继续拍摄
        </button>
        <button
          className="photo-delete"
          aria-label="删除选中照片"
          disabled={!chosen.length || processing > 0 || deleting || sharing}
          onClick={() => void removeSelected()}
        >
          <Trash2 size={17} aria-hidden="true" />
        </button>
      </div>
      {processing > 0 && (
        <p role="status">
          正在准备照片 {rows.filter((r) => r.hasOutput).length}/{rows.length}
        </p>
      )}
      <div className="photo-review-grid">
        {rows.map((row, index) => (
          <div className="photo-review-tile" key={row.meta.requestId}>
            <button
              className="photo-select"
              aria-label={`选择第${index + 1}张照片`}
              aria-pressed={selected.has(row.meta.requestId)}
              onClick={() => toggle(row.meta.requestId)}
            >
              <PhotoThumbnail
                ownerId={owner.id}
                workspaceId={owner.workspaceId}
                id={row.meta.requestId}
                ready={row.hasOutput}
                index={index}
                read={read}
              />
              <span className="photo-selection" aria-hidden="true">
                {selected.has(row.meta.requestId) && <Check size={14} />}
              </span>
              {row.error && <span className="photo-thumbnail-error">水印未完成</span>}
            </button>
            <button
              className="photo-tile-save"
              aria-label={`保存第${index + 1}张照片`}
              title="保存此照片"
              disabled={!row.hasOutput && !row.error}
              onClick={() => saveSingle(row.meta.requestId)}
            >
              <Download size={18} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {!rows.length && <p>暂无待保存照片</p>}
      <div className="photo-review-footer">
        {preparation === 'preparing' && chosen.length > 0 && chosen.every((r) => r.hasOutput) && (
          <p role="status">正在准备保存文件…</p>
        )}
        {notice && (
          <p role="status" aria-live="polite">
            {notice}
          </p>
        )}
        <button
          className="primary"
          disabled={
            !chosen.length ||
            sharing ||
            deleting ||
            preparation === 'preparing' ||
            chosen.some((r) => !r.hasOutput)
          }
          onClick={saveSelected}
        >
          {sharing ? '系统分享中…' : `保存选中照片（${chosen.length}张）`}
        </button>
      </div>
      {preview &&
        createPortal(
          <div
            className="photo-single-preview"
            role="dialog"
            aria-modal="true"
            aria-label="单张照片保存"
          >
            <header>
              <strong>{preview.raw ? '原始捕获文件（未加水印）' : '保存此照片'}</strong>
              <button
                autoFocus
                aria-label="关闭图片预览"
                onClick={() => {
                  previewVersion.current++;
                  setPreview(null);
                }}
              >
                <X size={22} />
              </button>
            </header>
            <img src={preview.src} alt="完整高清照片，可长按保存" />
            <p>可长按图片保存。下载请到文件/下载目录确认。</p>
            {previewShareable ? (
              <button disabled={sharing} onClick={() => saveFile(preview.file)}>
                保存此照片
              </button>
            ) : (
              !iosBrowser() &&
              'download' in HTMLAnchorElement.prototype && (
                <button onClick={() => requestDownload(preview.file)}>下载此照片</button>
              )
            )}
            {notice && <p role="status">{notice}</p>}
          </div>,
          document.body,
        )}
    </section>
  );
}
