import { photoTiming } from './photo-performance';
let worker: Worker | null = null,
  failed = false,
  sequence = 0,
  leases = 0,
  idle: ReturnType<typeof setTimeout> | undefined;
const jobs = new Map<
  number,
  { resolve: (b: Blob) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
function close() {
  worker?.terminate();
  worker = null;
  for (const j of jobs.values()) {
    clearTimeout(j.timer);
    j.reject(Error('图像编码线程中断，使用兼容捕获'));
  }
  jobs.clear();
}
function later() {
  clearTimeout(idle);
  if (!leases && !jobs.size) idle = setTimeout(close, 30000);
}
export function prepareFrameEncoder() {
  if (
    worker ||
    failed ||
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  )
    return;
  try {
    worker = new Worker(new URL('./photo-frame.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const j = jobs.get(data.id);
      if (!j) return;
      jobs.delete(data.id);
      clearTimeout(j.timer);
      if (data.error) j.reject(Error(data.error));
      else {
        photoTiming('capture-encode', performance.now() - data.encodeMs, { encoder: 'worker' });
        j.resolve(data.blob);
      }
      later();
    };
    worker.onerror = () => {
      failed = true;
      close();
    };
    later();
  } catch {
    failed = true;
    close();
  }
}
export function holdFrameEncoder() {
  leases++;
  clearTimeout(idle);
  prepareFrameEncoder();
  let active = true;
  return () => {
    if (active) {
      active = false;
      leases--;
      queueMicrotask(() => {
        if (!leases && !jobs.size) close();
        else later();
      });
    }
  };
}
export async function encodeVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<{ blob: Blob; capturedAt: string }> {
  prepareFrameEncoder();
  clearTimeout(idle);
  if (worker)
    try {
      const capturedAt = new Date().toISOString();
      const bitmap = await createImageBitmap(video);
      const blob = await new Promise<Blob>((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            failed = true;
            close();
          }, 15000);
        jobs.set(id, { resolve, reject, timer });
        try {
          worker!.postMessage({ id, bitmap }, [bitmap]);
        } catch (e) {
          bitmap.close();
          jobs.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
      return { blob, capturedAt };
    } catch {
      failed = true;
      close();
      /* Stable fallback retains actual pixels; no forced downscale. */
    }
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width) throw Error('相机画面未就绪');
  const capturedAt = new Date().toISOString();
  ctx.drawImage(video, 0, 0);
  const at = performance.now();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error('拍照编码失败'))), 'image/jpeg', 0.98),
  );
  photoTiming('capture-encode', at, { encoder: 'main' });
  later();
  return { blob, capturedAt };
}
