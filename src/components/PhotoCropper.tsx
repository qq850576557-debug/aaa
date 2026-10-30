import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { cropGeometry, maxCropZoom, type Crop } from '../lib/avatar-crop';
export type PhotoSource = { image: string; width: number; height: number; aspect: number };
export function PhotoCropper({
  source,
  busy,
  error,
  onClose,
  onChoose,
  onSave,
  onRemove,
}: {
  source: PhotoSource;
  busy: boolean;
  error: string;
  onClose: () => void;
  onChoose: () => void;
  onSave: (crop: Crop) => void;
  onRemove?: () => void;
}) {
  const [zoom, setZoom] = useState(1),
    [position, setPosition] = useState({ x: 0.5, y: 0.5 });
  const maxZoom = Math.max(1, maxCropZoom(source.width, source.height, source.aspect));
  const crop = cropGeometry(
    source.width,
    source.height,
    source.aspect,
    zoom,
    position.x,
    position.y,
  );
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
    width: number;
    height: number;
    crop: Crop;
  } | null>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || busy) return;
      e.preventDefault();
      setZoom((v) => Math.max(1, Math.min(maxZoom, v - e.deltaY * 0.001)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [maxZoom, busy]);
  return (
    <Modal
      title="调整头像照片"
      subtitle="拖动照片调整位置，滚轮或按钮缩放；预览即最终构图，不留边、不拉伸。"
      onClose={() => !busy && onClose()}
      blocking
      className="photo-crop-dialog"
    >
      <div className="modal-body">
        <div
          className="photo-crop-frame"
          ref={frame}
          style={{ aspectRatio: source.aspect }}
          aria-label="裁切效果预览"
          onPointerDown={(e) => {
            if (busy || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = e.currentTarget.getBoundingClientRect();
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              px: position.x,
              py: position.y,
              width: r.width,
              height: r.height,
              crop,
            };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setPosition({
              x: Math.max(
                0,
                Math.min(
                  1,
                  d.px -
                    (((e.clientX - d.x) / d.width) * d.crop.width) /
                      Math.max(1, source.width - d.crop.width),
                ),
              ),
              y: Math.max(
                0,
                Math.min(
                  1,
                  d.py -
                    (((e.clientY - d.y) / d.height) * d.crop.height) /
                      Math.max(1, source.height - d.crop.height),
                ),
              ),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <img
            src={source.image}
            alt="裁切后的照片预览"
            draggable={false}
            style={{
              width: `${(source.width / crop.width) * 100}%`,
              transform: `translate(${(-crop.x / source.width) * 100}%, ${(-crop.y / source.height) * 100}%)`,
            }}
          />
        </div>
        <div className="crop-zoom">
          <button
            aria-label="缩小照片"
            disabled={busy || zoom <= 1}
            onClick={() => setZoom((v) => Math.max(1, v - 0.1))}
          >
            −
          </button>
          <label>
            缩放
            <input
              aria-label="照片缩放"
              type="range"
              min="1"
              max={maxZoom}
              step=".01"
              value={zoom}
              disabled={busy || maxZoom <= 1}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <button
            aria-label="放大照片"
            disabled={busy || zoom >= maxZoom}
            onClick={() => setZoom((v) => Math.min(maxZoom, v + 0.1))}
          >
            ＋
          </button>
        </div>
        <p className="muted crop-size">
          原图 {source.width}×{source.height} · 裁切 {crop.width}×{crop.height}px · 保存不放大
        </p>
        {error && (
          <p className="photo-upload-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-foot">
        {onRemove && (
          <button className="destructive" disabled={busy} onClick={onRemove}>
            恢复默认头像
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => {
            setZoom(1);
            setPosition({ x: 0.5, y: 0.5 });
          }}
        >
          重新裁切
        </button>
        <button disabled={busy} onClick={onChoose}>
          重新选择
        </button>
        <button disabled={busy} onClick={onClose}>
          取消预览
        </button>
        <button className="primary" aria-busy={busy} disabled={busy} onClick={() => onSave(crop)}>
          {busy ? '正在保存…' : '保存头像'}
        </button>
      </footer>
    </Modal>
  );
}
