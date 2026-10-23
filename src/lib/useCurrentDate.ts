import { useEffect, useState } from 'react';
import { today } from './model';
export function useCurrentDate() {
  const [date, setDate] = useState(today);
  useEffect(() => {
    const refresh = () => setDate(today());
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return date;
}
