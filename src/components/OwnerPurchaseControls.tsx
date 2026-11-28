import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cloudApi, CloudError } from '../lib/cloud';
import { purchaseComplete, type Purchase, type PurchaseStatus } from '../lib/model';
import { Modal } from './Modal';
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
  | { action: 'order'; feedback: OwnerFeedback; reason?: string }
  | { action: 'reset' }
  | { action: 'return'; reason: string }
  | { action: 'reopen'; reason: string }
  | { action: 'finish' };
const feedbackFrom = ({ brand, model, note, link }: OwnerFeedback): OwnerFeedback => ({
  brand,
  model,
  note,
  ...(link === undefined ? {} : { link }),
});
export function OwnerPurchaseStatusDialog({
  purchase,
  status,
  founder,
  onClose,
  onChanged,
}: {
  purchase: Purchase;
  status: PurchaseStatus;
  founder: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={purchaseComplete(purchase) && status !== '已到货' ? '撤销到货' : `标为${status}`}
      subtitle={purchase.name}
      className="owner-purchase-status-dialog"
      blocking
      onClose={() => !busy && onClose()}
    >
      <div className="modal-body">
        <OwnerPurchaseFeedback
          project={purchase.projectId}
          id={purchase.id}
          founder={founder}
          onChanged={onChanged}
          statusChange={{ status, current: purchase.status, close: onClose, onBusy: setBusy }}
        />
      </div>
    </Modal>
  );
}
export function OwnerPurchaseFeedback({
  project,
  id,
  dirty = false,
  founder,
  onChanged,
  onLoaded,
  saving = false,
  statusChange,
}: {
  project: string;
  id: string;
  dirty?: boolean;
  founder: boolean;
  onChanged: () => void;
  onLoaded?: (item: OwnerPurchaseItem) => void;
  saving?: boolean;
  statusChange?: {
    status: PurchaseStatus;
    current: Purchase['status'];
    close: () => void;
    onBusy: (busy: boolean) => void;
  };
}) {
  const path = ownerPurchasePath(project, id);
  const target = statusChange?.status;
  const wasArrived = statusChange?.current === '已到货' || statusChange?.current === '已完成';
  const [item, setItem] = useState<OwnerPurchaseItem>();
  const [feedback, setFeedback] = useState<OwnerFeedback>({ brand: '', model: '', note: '' });
  const targetAction =
    wasArrived && target && target !== '已到货'
      ? 'reopen'
      : target === '已到货'
        ? 'finish'
        : target === '已下单'
          ? 'order'
          : target === '待采购'
            ? 'reset'
            : undefined;
  const [action, setAction] = useState<StaffAction['action'] | undefined>(targetAction);
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
      onLoaded?.(item);
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
    statusChange?.onBusy(true);
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
      if (statusChange && !(input.action === 'order' && target === '已到货')) {
        statusChange.close();
        return;
      }
      apply(value);
      setAction(targetAction);
      setReason('');
      setMessage(statusChange ? '下单信息已保存' : '已保存');
    } catch (error) {
      if (!current.current) return;
      if (error instanceof CloudError && error.status === 409) {
        receipt.current = undefined;
        setRetryRead(true);
        setMessage(error.message + '。如记录有变，请重新读取。');
      } else setMessage(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      if (current.current) {
        setBusy(false);
        statusChange?.onBusy(false);
      }
    }
  }
  const productLink = item?.link || item?.note.match(/https?:\/\/[^\s<>"'，。；、）]+/i)?.[0];
  const [photo, setPhoto] = useState<{ path: string; image: string }>();
  const photoPath = item?.imageId ? path + '/photo/' + item.imageId : '';
  useEffect(() => {
    setPhoto(undefined);
  }, [photoPath]);
  async function readPhoto() {
    try {
      const { image } = await cloudApi<{ image: string }>(photoPath);
      setPhoto({ path: photoPath, image });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '图片暂时无法读取');
    }
  }
  const disabled = busy || dirty || saving;
  const selectAction = (next: typeof action) => {
    setAction(next);
    setReason('');
    setMessage('');
    if (item)
      setFeedback(
        next === 'order' || item.bought ? feedbackFrom(item) : { brand: '', model: '', note: '' },
      );
  };
  const hasFeedback = item && (item.bought || item.feedbackAt || item.returnReason);
  if (!statusChange && !item?.published && !hasFeedback && !message) return null;
  const needsOrder =
    action === 'finish' &&
    statusChange &&
    item &&
    !item.bought &&
    statusChange.current !== '已下单';
  const needsReason =
    action === 'reopen' || action === 'return' || (action === 'order' && wasArrived);
  const needsDetails = action === 'order' || action === 'purchase';
  const missingOrderInfo = needsDetails && (!feedback.brand.trim() || !feedback.model.trim());
  return (
    <div className="span2 purchase-owner-feedback" onKeyDown={keepForm}>
      {statusChange && !item && !message && <p role="status">正在读取采购…</p>}
      {item && (
        <>
          {hasFeedback && (
            <div className="owner-purchase-preview">
              <strong>{item.complete ? '已到货' : item.bought ? '已下单' : '待采购'}</strong>
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
              {item.link && <p>购买链接 {item.link}</p>}
              {(productLink || item.note) && (
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
              {photoPath &&
                (photo?.path === photoPath ? (
                  <img
                    className="owner-feedback-photo"
                    src={'data:image/jpeg;base64,' + photo.image}
                    alt="业主购买图片"
                  />
                ) : (
                  <button type="button" onClick={() => void readPhoto()}>
                    查看购买图片
                  </button>
                ))}
              {item.returnReason && <p>对外说明 {item.returnReason}</p>}
            </div>
          )}
          {item.published && !statusChange && (
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
                    确认到货
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
              {needsDetails && (
                <fieldset className="owner-purchase-fields" disabled={disabled}>
                  <label className="form-field">
                    品牌
                    <input
                      maxLength={80}
                      required
                      value={feedback.brand}
                      onChange={(event) => setFeedback({ ...feedback, brand: event.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    型号
                    <input
                      maxLength={80}
                      required
                      value={feedback.model}
                      onChange={(event) => setFeedback({ ...feedback, model: event.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    购买链接
                    <input
                      type="url"
                      maxLength={1000}
                      value={feedback.link ?? ''}
                      onChange={(event) => setFeedback({ ...feedback, link: event.target.value })}
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
              )}
              {action === 'finish' && (
                <p>{needsOrder ? '请先填写品牌和型号并确认下单。' : '确认这项采购已到货？'}</p>
              )}
              {action === 'reset' && <p>确认将这项采购退回待采购？</p>}
              {needsReason && (
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
                  disabled={disabled || missingOrderInfo || (needsReason && !reason.trim())}
                  className="primary"
                  onClick={() => {
                    if (needsOrder) return selectAction('order');
                    void save(
                      action === 'order'
                        ? { action, feedback, ...(needsReason ? { reason } : {}) }
                        : action === 'purchase'
                          ? { action, feedback }
                          : action === 'finish' || action === 'reset'
                            ? { action }
                            : { action, reason },
                    );
                  }}
                >
                  {needsOrder ? '填写下单信息' : '确认'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={statusChange?.close ?? (() => selectAction(undefined))}
                >
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
