import { useEffect, useState } from 'react';
import { cloudApi } from '../lib/cloud';
export function LegacySource({ kind, id }: { kind: 'purchase' | 'record'; id: string }) {
  const [sources, setSources] = useState<unknown[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void cloudApi<{ sources: unknown[] }>(
      `/legacy-migration/source/${kind}/${encodeURIComponent(id)}`,
    )
      .then((v) => {
        if (active) setSources(v.sources);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [kind, id]);
  if (error) return <p role="alert">历史来源读取失败：{error}</p>;
  if (!sources.length) return null;
  return (
    <details className="legacy-provenance">
      <summary>历史来源与原始创建记录</summary>
      <p>
        此记录由迁移创建，迁移时间不代表原始创建时间。以下来源及原有历史原样保留；未记录的原始时间不推测。
      </p>
      <pre>{JSON.stringify(sources, null, 2)}</pre>
    </details>
  );
}
