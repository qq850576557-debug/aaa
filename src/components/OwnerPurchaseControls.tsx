import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cloudApi, CloudError } from '../lib/cloud';
import {
  ownerPurchasePath,
  type OwnerFeedback,
  type OwnerPublication,
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

export function defaultPublication(title: string): OwnerPublication {
  return {
    responsibility: 'company',
    published: false,
    title,
    description: '',
    specification: '',
    quantity: '',
    reference: '',
  };
}

const keepForm = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
};

export function OwnerPublicationFields({
  value,
  due,
  enabled,
  busy,
  onChange,
}: {
  value: OwnerPublication;
  due: string;
  enabled: boolean;
  busy?: boolean;
  onChange: (fields: OwnerPublication) => void;
}) {
  return (
    <fieldset className="owner-purchase-fields" disabled={busy}>
      <div className="form-grid">
        <label className="form-field">
          采购责任方
          <select
            value={value.responsibility}
            onChange={(event) => {
              const responsibility = event.target.value as OwnerPublication['responsibility'];
              onChange({
                ...value,
                responsibility,
                published: responsibility === 'owner' && value.published,
              });
            }}
          >
            <option value="company">春茉采购</option>
            <option value="owner">业主采购</option>
            <option value="supplier">商家或供应商负责</option>
          </select>
        </label>
        <label className="owner-publish-check">
          <input
            type="checkbox"
            checked={value.published}
            disabled={value.responsibility !== 'owner' || (!enabled && !value.published)}
            onChange={(event) => onChange({ ...value, published: event.target.checked })}
          />
          向业主发布
        </label>
        {!enabled && <p className="span2 owner-purchase-hint">该项目的业主采购服务已关闭。</p>}
        {value.responsibility === 'owner' && (
          <>
            <label className="form-field span2">
              对外采购名称
              <input
                value={value.title}
                maxLength={100}
                onChange={(event) => onChange({ ...value, title: event.target.value })}
              />
            </label>
            <label className="form-field span2">
              对外采购说明
              <textarea
                rows={3}
                value={value.description}
                maxLength={4000}
                onChange={(event) => onChange({ ...value, description: event.target.value })}
              />
            </label>
            <label className="form-field">
              对外规格 / 尺寸
              <input
                value={value.specification}
                maxLength={1000}
                onChange={(event) => onChange({ ...value, specification: event.target.value })}
              />
            </label>
            <label className="form-field">
              对外数量
              <input
                value={value.quantity}
                maxLength={100}
                onChange={(event) => onChange({ ...value, quantity: event.target.value })}
              />
            </label>
            <label className="form-field span2">
              参考资料链接（选填）
              <input
                value={value.reference}
                maxLength={1000}
                inputMode="url"
                onChange={(event) => onChange({ ...value, reference: event.target.value })}
              />
            </label>
            <div className="owner-purchase-preview span2">
              <small>业主端预览</small>
              <strong>{value.title || '请填写对外采购名称'}</strong>
              {due && <small>最迟采购日期 {due}</small>}
              {value.description && <p>{value.description}</p>}
              {value.specification && <p>规格 {value.specification}</p>}
              {value.quantity && <p>数量 {value.quantity}</p>}
              {value.reference && <p>{value.reference}</p>}
            </div>
          </>
        )}
      </div>
    </fieldset>
  );
}

type StaffAction =
  | { action: 'publication'; publication: OwnerPublication }
  | { action: 'purchase'; feedback: OwnerFeedback }
  | { action: 'return' | 'reopen'; reason: string }
  | { action: 'finish' };
const feedbackFrom = ({ brand, model, note }: OwnerFeedback) => ({ brand, model, note });
const publicationFrom = ({
  responsibility,
  published,
  title,
  description,
  specification,
  quantity,
  reference,
}: OwnerPublication) => ({
  responsibility,
  published,
  title,
  description,
  specification,
  quantity,
  reference,
});

export function OwnerPurchaseControls({
  project,
  id,
  dirty,
  founder,
  onChanged,
}: {
  project: string;
  id: string;
  dirty: boolean;
  founder: boolean;
  onChanged: () => void;
}) {
  const path = ownerPurchasePath(project, id);
  const [item, setItem] = useState<OwnerPurchaseItem>();
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<OwnerPublication>();
  const [feedback, setFeedback] = useState<OwnerFeedback>({ brand: '', model: '', note: '' });
  const [action, setAction] = useState<'purchase' | 'return' | 'reopen' | 'finish'>();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const receipt = useRef<{ key: string; id: string }>(undefined);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const apply = (value: { item: OwnerPurchaseItem; enabled: boolean }) => {
    setItem(value.item);
    setEnabled(value.enabled);
    setDraft(publicationFrom(value.item));
    setFeedback(feedbackFrom(value.item));
  };
  async function load() {
    if (busy) return;
    setBusy(true);
    try {
      const value = await cloudApi<{ item: OwnerPurchaseItem; enabled: boolean }>(path);
      if (current.current) {
        apply(value);
        setMessage('');
      }
    } catch (error) {
      if (current.current) setMessage(error instanceof Error ? error.message : '读取失败');
    } finally {
      if (current.current) setBusy(false);
    }
  }
  async function save(input: StaffAction) {
    if (!item || busy || dirty) return;
    const body = { ...input, version: item.version };
    const key = JSON.stringify(body);
    if (receipt.current?.key !== key) receipt.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setMessage('');
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
        setMessage(error.message + '。如记录有变，请重新读取。');
      } else setMessage(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      if (current.current) setBusy(false);
    }
  }
  const productLink = item?.note.match(/https?:\/\/[^\s<>"'，。；、）]+/i)?.[0];
  const disabled = busy || dirty;
  const publicationChanged = !!(
    item &&
    draft &&
    JSON.stringify(publicationFrom(item)) !== JSON.stringify(draft)
  );
  const selectAction = (next: typeof action) => {
    setAction(next);
    setReason('');
    setMessage('');
    if (item) setFeedback(item.bought ? feedbackFrom(item) : { brand: '', model: '', note: '' });
  };
  return (
    <details
      className="owner-purchase-controls span2"
      onKeyDown={keepForm}
      onToggle={(event) => {
        if (event.currentTarget.open && !open) {
          setOpen(true);
          void load();
        }
      }}
    >
      <summary>业主采购协同</summary>
      {dirty && <p className="owner-purchase-hint">请先保存当前采购修改，再操作业主协同。</p>}
      {busy && !item && <p role="status">正在读取…</p>}
      {item && draft && (
        <>
          <OwnerPublicationFields
            value={draft}
            due={item.due}
            enabled={enabled}
            busy={disabled}
            onChange={setDraft}
          />
          <div className="owner-purchase-actions">
            <button
              type="button"
              disabled={disabled || !publicationChanged || !draft.title.trim()}
              onClick={() => void save({ action: 'publication', publication: draft })}
            >
              {draft.published ? '确认发布' : item.published ? '撤回发布' : '保存协同设置'}
            </button>
            <button type="button" disabled={busy} onClick={() => void load()}>
              重新读取
            </button>
          </div>
          {(item.bought || item.feedbackAt || item.returnReason) && (
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
      {!item && message && (
        <button type="button" onClick={() => void load()}>
          重试读取
        </button>
      )}
    </details>
  );
}
