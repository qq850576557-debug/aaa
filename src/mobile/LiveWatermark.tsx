import { memo, useEffect, useState } from 'react';
import { photoTime } from '../lib/site-photo';
export const LiveWatermark = memo(function LiveWatermark({
  place,
  actor,
}: {
  place?: string;
  actor: string;
}) {
  const [at, setAt] = useState(() => new Date().toISOString());
  useEffect(() => {
    const t = setInterval(() => setAt(new Date().toISOString()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="live-watermark" aria-label="实时水印">
      <div>
        <img src="/brand/source/chunmo-original.jpg" alt="春茉原始Logo" />
        春茉设计
      </div>
      <span>工地定位：{place}</span>
      <span>拍摄时间：{photoTime(at)}</span>
      <span>拍摄人员：{actor}</span>
    </div>
  );
});
