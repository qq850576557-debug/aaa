import { useEffect } from 'react';
import { cloudApi } from './cloud';
import { browserPresence } from './presence-state';
export function usePresenceHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let id = '',
      lastActivity = Date.now(),
      lastStatus = '',
      lastSent = 0,
      busy = false,
      alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Focus alone is not user activity; returning requires a new interaction.
    const send = () => {
      if (!id || !alive) return;
      const now = Date.now(),
        status = browserPresence(
          document.visibilityState === 'visible',
          document.hasFocus(),
          lastActivity,
          now,
        );
      if (busy || (status === lastStatus && now - lastSent < 30000)) return;
      if (now - lastSent < 750) {
        clearTimeout(timer);
        timer = setTimeout(send, 750 - (now - lastSent));
        return;
      }
      busy = true;
      lastSent = now;
      lastStatus = status;
      void cloudApi('/presence', 'POST', {
        clientId: id,
        status,
        idleMs: Math.min(86400000, Math.max(0, now - lastActivity)),
      })
        .catch(() => {
          lastStatus = '';
        })
        .finally(() => {
          busy = false;
        });
    };
    const activity = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        lastActivity = Date.now();
        send();
      }
    };
    const foreground = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) lastActivity = 0;
      send();
    };
    const connected = (e: Event) => {
      const clientId = (e as CustomEvent).detail?.clientId;
      if (clientId) {
        id = clientId;
        lastStatus = '';
        lastSent = 0;
        send();
      }
    };
    for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'])
      window.addEventListener(name, activity, { passive: true });
    window.addEventListener('focus', foreground);
    window.addEventListener('blur', foreground);
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('chunmo-presence', connected);
    const interval = setInterval(send, 1000); // Local idle check; network heartbeat is at most every 30s.
    return () => {
      alive = false;
      clearInterval(interval);
      clearTimeout(timer);
      for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'])
        window.removeEventListener(name, activity);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('blur', foreground);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('chunmo-presence', connected);
    };
  }, [enabled]);
}
