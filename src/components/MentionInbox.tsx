import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { cloudApi } from '../lib/cloud';
import { Modal, type Anchor } from './Modal';
import './mentions.css';
type Notice = {
  id: string;
  actorName: string;
  kind: 'purchase' | 'record';
  recordId: string;
  projectName: string;
  title: string;
  summary: string;
  date: string;
  createdAt: string;
  readAt: string | null;
};
export function MentionInbox() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [unread, setUnread] = useState(0),
    [items, setItems] = useState<Notice[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [more, setMore] = useState(false);
  const active = useRef(false),
    flight = useRef<Promise<void> | null>(null);
  const load = useCallback((): Promise<void> => {
    if (flight.current) return flight.current;
    const run = (async () => {
      try {
        const r = await cloudApi<{ unread: number; notifications: Notice[] }>('/notifications');
        if (active.current) {
          setUnread(r.unread);
          setItems(r.notifications);
          setMore(r.notifications.length === 30);
          setError('');
        }
      } catch (e) {
        if (active.current) setError(String(e));
      } finally {
        flight.current = null;
      }
    })();
    flight.current = run;
    return run;
  }, []);
  useEffect(() => {
    active.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('chunmo-mentions-changed', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 30000);
    return () => {
      active.current = false;
      clearInterval(timer);
      window.removeEventListener('chunmo-mentions-changed', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);
  const read = async (ids?: string[]) => {
    await cloudApi('/notifications/read', 'POST', ids ? { ids } : { all: true });
    await flight.current;
    await load();
    window.dispatchEvent(new Event('chunmo-mentions-changed'));
  };
  return (
    <>
      <button
        className="mention-inbox-button"
        aria-label={`我的@消息${unread ? '，' + unread + '条未读' : ''}`}
        onClick={(e) => {
          setAnchor({ x: e.clientX, y: e.clientY, element: e.currentTarget });
          setOpen(true);
          void load();
        }}
      >
        <Bell size={18} />
        {unread > 0 && <b>{unread > 99 ? '99+' : unread}</b>}
      </button>
      {open && (
        <Modal
          title="我的@消息"
          anchor={anchor ?? undefined}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          className="mention-inbox"
        >
          <div className="modal-body">
            <div className="mention-inbox-tools">
              <span>{unread}条未读</span>
              <button
                disabled={busy || !unread}
                onClick={() => {
                  setBusy(true);
                  void read()
                    .catch((e) => setError(String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                全部标记已读
              </button>
            </div>
            {error && (
              <p role="alert">
                {error}
                <button onClick={() => void load()}>重试</button>
              </p>
            )}
            {!items.length && <p>暂无@消息</p>}
            {items.map((n) => (
              <article key={n.id} className={n.readAt ? 'mention-notice' : 'mention-notice unread'}>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      const target = await cloudApi(`/notifications/${n.id}/target`);
                      const event = new CustomEvent('chunmo-open-mention', {
                        cancelable: true,
                        detail: target,
                      });
                      if (window.dispatchEvent(event)) {
                        await read([n.id]);
                        setOpen(false);
                      }
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <small>
                    {n.actorName} @了你 · {n.readAt ? '已读' : '未读'} ·{' '}
                    {n.kind === 'purchase' ? '采购' : '事项'}
                  </small>
                  <strong>{n.title}</strong>
                  <span>
                    {n.projectName} · {n.date || '历史未设日期'}
                  </span>
                  <p>{n.summary}</p>
                  <small>
                    {new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                  </small>
                </button>
                {!n.readAt && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void read([n.id])
                        .catch((e) => setError(String(e)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    标记已读
                  </button>
                )}
              </article>
            ))}
            {more && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await cloudApi<{ notifications: Notice[] }>(
                      `/notifications?before=${items.at(-1)!.id}`,
                    );
                    setItems((old) => [...old, ...r.notifications]);
                    setMore(r.notifications.length === 30);
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                更早消息
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
