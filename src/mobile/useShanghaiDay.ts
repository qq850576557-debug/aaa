import { useEffect, useState } from 'react';
import { assessmentToday } from '../lib/assessments';
export function useShanghaiDay() {
  const [day, setDay] = useState(assessmentToday);
  useEffect(() => {
    const refresh = () => setDay(assessmentToday());
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return day;
}
