import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, TriangleAlert, X } from 'lucide-react';
type Notice = { id: number; message: string; error: boolean };
export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const sequence = useRef(0),
    timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setNotices((items) => items.filter((n) => n.id !== id));
  }, []);
  const notify = useCallback(
    (message: string) => {
      const id = ++sequence.current,
        error = /失败|无法|错误/.test(message);
      setNotices((items) => {
        const all = [...items, { id, message, error }];
        const recent = new Set(
          all
            .filter((n) => !n.error)
            .slice(-4)
            .map((n) => n.id),
        );
        return all.filter((n) => n.error || recent.has(n.id));
      });
      if (!error)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), 3000),
        );
    },
    [dismiss],
  );
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);
  return { notices, notify, dismiss };
}
export function Notifications({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack" aria-live="polite">
      {notices.map((n) => (
        <div
          key={n.id}
          className={`toast ${n.error ? 'error-toast' : ''}`}
          role={n.error ? 'alert' : 'status'}
        >
          {n.error ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}
          <span>{n.message}</span>
          <button aria-label="关闭提示" onClick={() => onDismiss(n.id)}>
            <X size={17} />
          </button>
        </div>
      ))}
    </div>
  );
}
