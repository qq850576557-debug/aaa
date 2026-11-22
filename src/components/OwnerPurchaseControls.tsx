import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cloudApi, CloudError } from '../lib/cloud';
import {
  ownerPurchasePath,
  type OwnerFeedback,
  type OwnerPurchaseIndex,
  type OwnerPurchaseItem,
} from '../lib/owner-purchases';
import './owner-purchase.css';

const emptyIndex: OwnerPurchaseIndex = { projects: [], items: [] };
export function useOwnerPurchaseIndex(active: boolean) {
  const [index, setIndex] = useState(emptyIndex);
  const generation = useRef(0);
  const unsupported = useRef(false);
  const refresh = useCallback(() => {
    if (!active || document.hidden || unsupported.current) return;
    const request = ++generation.current;
    void cloudApi<OwnerPurchaseIndex>('/owner-purchases').then(
      (value) => {
        if (request === generation.current) setIndex(value);
      },
      (error) => {
        if (request !== generation.current || !(error instanceof CloudError)) return;
        if (error.status === 404) unsupported.current = true;
        if ([401, 403, 404].includes(error.status)) setIndex(emptyIndex);
      },
    );
  }, [active]);
  useEffect(() => {
    if (!active) {
      setIndex(emptyIndex);
      return;
    }
    unsupported.current = false;
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, refresh]);
  return { index, refresh };
}

const keepForm = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
};

type StaffAction =
  | { action: 'purchase'; feedback: OwnerFeedback }
  | { action: 'return' | 'reopen'; reason: string }
  | { action: 'finish' };
const feedbackFrom = ({ brand, model, note }: OwnerFeedback) => ({ brand, model, note });
export function OwnerPurchaseFeedback({
  project,
  id,
  dirty,
  founder,
  onChanged,
  onLoaded,
  saving,
}: {
  project: string;
  id: string;
  dirty: boolean;
  founder: boolean;
  onChanged: () => void;
  onLoaded: (item: OwnerPurchaseItem) => void;
  saving: boolean;
}) {
  const path = ownerPurchasePath(project, id);
  const [item, setItem] = useState<OwnerPurchaseItem>();
  const [feedback, setFeedback] = useState<OwnerFeedback>({ brand: '', model: '', note: '' });
  const [action, setAction] = useState<'purchase' | 'return' | 'reopen' | 'finish'>();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [retryRead, setRetryRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const receipt = useRef<{ key: string; id: string }>(undefined);
  const current = useRef(true);
  const readSequence = useRef(0);
  const apply = useCallback(
    ({ item }: { item: OwnerPurchaseItem }) => {
      setItem(item);
      onLoaded(item);
      setFeedback(feedbackFrom(item));
    },
    [onLoaded],
  );
  const load = useCallback(async () => {
    const request = ++readSequence.current;
    setBusy(true);
    try {
      const value = await cloudApi<{ item: OwnerPurchaseItem; enabled: boolean }>(path);
      if (request === readSequence.current) {
        apply(value);
        setMessage('');
        setRetryRead(false);
      }
    } catch (error) {
      if (request === readSequence.current) {
        setRetryRead(true);
        setMessage(error instanceof Error ? error.message : '读取失败');
      }
    } finally {
      if (request === readSequence.current) setBusy(false);
    }
  }, [apply, path]);
  useEffect(() => {
    current.current = true;
    void load();
    return () => {
      current.current = false;
      readSequence.current++;
    };
  }, [load]);
  async function save(input: StaffAction) {
    if (!item || busy || dirty || saving) return;
    const body = { ...input, version: item.version };
    const key = JSON.stringify(body);
    if (receipt.current?.key !== key) receipt.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setMessage('');
    setRetryRead(false);
    try {
      const value = await cloudApi<{ item: OwnerPurchaseItem; enabled: boolean }>(path, 'POST', {
        ...body,
        requestId: receipt.current.id,
      });
      receipt.current = undefined;
      onChanged();
      if (!current.current) return;
      apply(value);
      setAction(undefined);
      setReason('');
      setMessage('已保存');
    } catch (error) {
      if (!current.current) return;
      if (error instanceof CloudError && error.status === 409) {
        receipt.current = undefined;
        setRetryRead(true);
        setMessage(error.message + '。如记录有变，请重新读取。');
      } else setMessage(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      if (current.current) setBusy(false);
    }
  }
  const productLink = item?.note.match(/https?:\/\/[^\s<>"'，。；、）]+/i)?.[0];
  const disabled = busy || dirty || saving;
  const selectAction = (next: typeof action) => {
    setAction(next);
    setReason('');
    setMessage('');
    if (item) setFeedback(item.bought ? feedbackFrom(item) : { brand: '', model: '', note: '' });
  };
  const hasFeedback = item && (item.bought || item.feedbackAt || item.returnReason);
  if (!item?.published && !hasFeedback && !message) return null;
  return (
    <div className="span2 purchase-owner-feedback" onKeyDown={keepForm}>
      {item && (
        <>
          {hasFeedback && (
            <div className="owner-purchase-preview">
              <strong>
                {item.complete ? '采购已完成' : item.bought ? '已购买 · 待公司复核' : '待采购'}
              </strong>
              {item.feedbackAt && (
                <small>
                  {item.feedbackActor} ·{' '}
                  {new Date(item.feedbackAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  })}
                </small>
              )}
              {item.brand && <p>品牌 {item.brand}</p>}
              {item.model && <p>型号 {item.model}</p>}
              {item.note && <p>{item.note}</p>}
              {item.note && (
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(productLink ?? item.note).then(
                      () => setMessage(productLink ? '已复制商品链接' : '已复制购买备注'),
                      () => setMessage('请选中文字手动复制'),
                    )
                  }
                >
                  {productLink ? '复制商品链接' : '复制购买备注'}
                </button>
              )}
              {item.returnReason && <p>对外说明 {item.returnReason}</p>}
            </div>
          )}
          {item.published && (
            <div className="owner-purchase-actions">
              {!item.complete && (
                <button type="button" disabled={disabled} onClick={() => selectAction('purchase')}>
                  {item.bought ? '修改购买反馈' : '代为确认购买'}
                </button>
              )}
              {!item.complete && item.bought && (
                <>
                  <button type="button" disabled={disabled} onClick={() => selectAction('return')}>
                    退回待采购
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={disabled}
                    onClick={() => selectAction('finish')}
                  >
                    确认采购完成
                  </button>
                </>
              )}
              {item.complete && founder && (
                <button type="button" disabled={disabled} onClick={() => selectAction('reopen')}>
                  重新开启采购
                </button>
              )}
            </div>
          )}
          {action && (
            <div className="owner-purchase-preview">
              {action === 'purchase' ? (
                <fieldset className="owner-purchase-fields" disabled={disabled}>
                  <label className="form-field">
                    品牌
                    <input
                      maxLength={80}
                      value={feedback.brand}
                      onChange={(event) => setFeedback({ ...feedback, brand: event.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    型号
                    <input
                      maxLength={80}
                      value={feedback.model}
                      onChange={(event) => setFeedback({ ...feedback, model: event.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    购买备注
                    <textarea
                      maxLength={1000}
                      value={feedback.note}
                      onChange={(event) => setFeedback({ ...feedback, note: event.target.value })}
                    />
                  </label>
                </fieldset>
              ) : action === 'finish' ? (
                <p>确认后，业主可查看购买信息。</p>
              ) : (
                <label className="form-field">
                  对外说明
                  <textarea
                    maxLength={1000}
                    value={reason}
                    disabled={disabled}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              )}
              <div className="owner-purchase-actions">
                <button
                  type="button"
                  disabled={disabled || (['return', 'reopen'].includes(action) && !reason.trim())}
                  className="primary"
                  onClick={() =>
                    void save(
                      action === 'purchase'
                        ? { action, feedback }
                        : action === 'finish'
                          ? { action }
                          : { action, reason },
                    )
                  }
                >
                  确认
                </button>
                <button type="button" disabled={busy} onClick={() => selectAction(undefined)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {message && (
        <p role="status" className="owner-purchase-hint">
          {message}
        </p>
      )}
      {retryRead && (
        <button type="button" disabled={disabled} onClick={() => void load()}>
          重试读取
        </button>
      )}
    </div>
  );
}
