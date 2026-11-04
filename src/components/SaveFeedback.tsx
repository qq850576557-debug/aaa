import { downloadLocalRecovery } from './SyncStatus';
import { pendingRecords, verifiedOwner } from '../lib/record-outbox';
import { useEffect, useState, type ReactNode } from 'react';
export const savedFeedback = (
  key: string,
  kind: 'workspace' | 'record' | 'restore' = 'workspace',
) => window.dispatchEvent(new CustomEvent('chunmo-save-confirmed', { detail: { key, kind } }));
export const failedFeedback = () => window.dispatchEvent(new Event('chunmo-save-failed'));
export function SaveFeedback({
  children,
  status,
  cloud = true,
  onRetry,
}: {
  children?: ReactNode;
  status: string;
  cloud?: boolean;
  onRetry?: () => void;
}) {
  const owner = verifiedOwner();
  const key = `chunmo-confirmed:${owner?.workspaceId ?? ''}:${owner?.id ?? ''}`;
  const [at, setAt] = useState(() => sessionStorage.getItem(key) || '');
  const [recordState, setRecordState] = useState('');
  const [details, setDetails] = useState(false);
  useEffect(() => {
    setAt(sessionStorage.getItem(key) || '');
    setRecordState('');
    const confirmed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.owner?.id !== owner?.id || detail.owner?.workspaceId !== owner?.workspaceId)
        return;
      const value = detail.at;
      setAt((old) => (old > value ? old : value));
      sessionStorage.setItem(key, [sessionStorage.getItem(key) || '', value].sort().at(-1)!);
    };
    const outbox = (e: Event) => setRecordState(String((e as CustomEvent).detail));
    const failed = () => setRecordState('同步失败，请保留本地内容并核对');
    window.addEventListener('chunmo-cloud-confirmed-time', confirmed);
    window.addEventListener('chunmo-outbox-status', outbox);
    window.addEventListener('chunmo-save-failed', failed);
    if (owner)
      void pendingRecords(owner).then((rows) => {
        if (rows.length)
          setRecordState(rows.some((r) => r.blocked) ? '存在待处理冲突' : '本地已保存·待同步');
      });
    return () => {
      window.removeEventListener('chunmo-cloud-confirmed-time', confirmed);
      window.removeEventListener('chunmo-outbox-status', outbox);
      window.removeEventListener('chunmo-save-failed', failed);
    };
  }, [key]);
  const failed = /失败|冲突|异常|未保存|待恢复/.test(status + ' ' + recordState);
  const pending = /正在|待同步|本地已保存|上传/.test(status + ' ' + recordState);
  const formatted = at
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(at))
    : [];
  const part = (type: string) => formatted.find((p) => p.type === type)?.value;
  const message = failed
    ? '同步异常·点击核对'
    : pending
      ? navigator.onLine && /正在|上传|同步中/.test(status + ' ' + recordState)
        ? '正在同步'
        : '本地已保存·待同步'
      : at && cloud
        ? `最新保存：${part('year')}年${part('month')}月${part('day')}日 ${part('hour')}点${part('minute')}分`
        : cloud
          ? '尚无云端保存确认'
          : '本地工作空间';
  return (
    <div className="sidebar-save-status" role="status">
      <button onClick={() => setDetails(!details)} aria-expanded={details} aria-label={message}>
        <span className="save-label">最新保存：</span>
        <time className="save-confirmed-time" dateTime={at || undefined}>
          {at && cloud
            ? `${part('year')}年${part('month')}月${part('day')}日 ${part('hour')}点${part('minute')}分`
            : cloud
              ? '尚无云端确认'
              : '本地工作空间'}
        </time>
        <span
          className="save-current-state"
          style={{ visibility: failed || pending ? 'visible' : 'hidden' }}
        >
          {failed || pending ? message : '\u00a0'}
        </span>
      </button>
      {details && (
        <div>
          <p>
            {status} · {recordState}
          </p>
          {failed && <p>本地内容保留。冲突请在对应记录核对，不能强行覆盖。</p>}
          <button
            onClick={() => {
              onRetry?.();
              window.dispatchEvent(new Event('online'));
              window.dispatchEvent(new Event('focus'));
            }}
          >
            重试同步
          </button>
          <button onClick={() => void downloadLocalRecovery()}>下载未同步内容</button>
          {children}
        </div>
      )}
    </div>
  );
}
