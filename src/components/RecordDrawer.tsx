import { LegacySource } from './LegacySource';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { cloudApi, CloudError } from '../lib/cloud';
import {
  recordStatuses,
  recordValue,
  recordFields,
  recordData,
  type WorkRecord,
  type RecordValue,
  type RecordHistory,
} from '../lib/records';
import type { Project } from '../lib/model';
import { Modal, Confirm } from './Modal';
import { DateField } from './DateField';
import './record-board.css';
const timestamp = (s: string) =>
  new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const blank = (projectId = '', date = ''): RecordValue => ({
  projectId,
  title: '',
  nodeDate: date,
  status: '待执行',
  notes: '',
  followUp: '',
  owner: '',
});
export function RecordDrawer({
  record,
  initialProject,
  projects,
  latest,
  initialDate = '',
  intro,
  embedded = false,
  onDirty,
  onBusyChange,
  onClose,
  onSaved,
}: {
  record?: WorkRecord;
  initialProject: string;
  projects: Project[];
  latest?: WorkRecord;
  initialDate?: string;
  intro?: ReactNode;
  embedded?: boolean;
  onDirty: (v: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onSaved: (r: WorkRecord) => void;
}) {
  const [base, setBase] = useState(record),
    [value, setValue] = useState<RecordValue>(() =>
      record ? recordData(record) : blank(initialProject, initialDate),
    ),
    [tab, setTab] = useState('details'),
    [history, setHistory] = useState<RecordHistory[]>([]),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false),
    [reloadConfirm, setReloadConfirm] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const original = base ? recordData(base) : blank(initialProject, initialDate);
  const changed = JSON.stringify(value) !== JSON.stringify(original);
  useEffect(() => onDirty(changed), [changed, onDirty]);
  useEffect(() => {
    if (!changed) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [changed]);
  const stale = !!base && (!latest || latest.version !== base.version);
  useEffect(() => {
    if (tab !== 'history' || !base) return;
    let active = true;
    setHistoryBusy(true);
    setHistoryError('');
    void cloudApi<{ events: RecordHistory[] }>(`/records/${encodeURIComponent(base.id)}/history`)
      .then((r) => {
        if (active) setHistory(r.events);
      })
      .catch((e) => {
        if (active) setHistoryError(String(e));
      })
      .finally(() => {
        if (active) setHistoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [tab, base?.id, latest?.version]);
  const change = (key: keyof RecordValue, v: string) => {
    setValue((old) => ({ ...old, [key]: v }));
    setError('');
  };
  async function save(remove = false) {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const parsed = remove ? null : recordValue.parse(value);
      const payload = remove
        ? { version: base!.version }
        : { value: parsed, ...(base ? { version: base.version } : {}) };
      const key = JSON.stringify({ id: base?.id, remove, payload });
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const r = await cloudApi<WorkRecord>(
        base ? `/records/${encodeURIComponent(base.id)}` : '/records',
        remove ? 'DELETE' : base ? 'PUT' : 'POST',
        { ...payload, requestId: request.current.id },
      );
      onSaved(r);
    } catch (e) {
      setError(e instanceof CloudError ? e.message : '请检查任务事项、所属项目及节点日期。');
      setDeleting(false);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <>
      <Modal
        inline={embedded}
        title={base ? base.title : '新增记录'}
        subtitle={base ? '项目跟进记录' : '把需要跟进的事项留在项目中'}
        onClose={() => {
          if (!busy) onClose();
        }}
        placement="right"
        className="record-drawer"
      >
        {intro}
        <div className="record-tabs" role="tablist" aria-label="记录详情标签">
          <button
            role="tab"
            id="record-detail-tab"
            aria-controls="record-detail-panel"
            aria-selected={tab === 'details'}
            onClick={() => setTab('details')}
          >
            详情
          </button>
          <button
            role="tab"
            id="record-history-tab"
            aria-controls="record-history-panel"
            aria-selected={tab === 'history'}
            disabled={!base}
            onClick={() => setTab('history')}
          >
            历史
          </button>
        </div>
        <div className="record-drawer-body">
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {stale && (
            <div className="record-stale" role="status">
              此记录已被其他人修改或删除；当前草稿已保留。
              <button disabled={busy} onClick={() => setReloadConfirm(true)}>
                重新读取已保存版本
              </button>
            </div>
          )}
          {tab === 'details' ? (
            <form
              id="record-form"
              role="tabpanel"
              aria-labelledby="record-detail-tab"
              className="record-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                <span>项目</span>
                <select
                  aria-label="记录所属项目"
                  required
                  disabled={!!base || busy}
                  value={value.projectId}
                  onChange={(e) => change('projectId', e.target.value)}
                >
                  <option value="">选择项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {base && !projects.some((p) => p.id === base.projectId) && (
                    <option value={base.projectId}>{base.projectName}（项目已移除）</option>
                  )}
                </select>
              </label>
              <label>
                <span>任务事项</span>
                <textarea
                  aria-label="任务事项"
                  required
                  maxLength={240}
                  rows={2}
                  value={value.title}
                  disabled={busy}
                  onChange={(e) => change('title', e.target.value)}
                  placeholder="需要完成或持续跟进的事项"
                />
              </label>
              <div className="record-field-date">
                <span>节点日期</span>
                <DateField
                  label="记录节点日期"
                  required={!!initialDate}
                  hideLabel
                  value={value.nodeDate}
                  onChange={(v) => {
                    if (!busy) change('nodeDate', v);
                  }}
                />
              </div>
              <label>
                <span>状态</span>
                <select
                  aria-label="记录状态"
                  value={value.status}
                  disabled={busy}
                  onChange={(e) => change('status', e.target.value)}
                >
                  {recordStatuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>负责人</span>
                <input
                  aria-label="事项负责人"
                  maxLength={100}
                  value={value.owner ?? ''}
                  disabled={busy}
                  onChange={(e) => change('owner', e.target.value)}
                />
              </label>
              <label>
                <span>具体内容 / 备注</span>
                <textarea
                  aria-label="记录备注"
                  rows={4}
                  maxLength={4000}
                  value={value.notes}
                  disabled={busy}
                  onChange={(e) => change('notes', e.target.value)}
                  placeholder="补充现场情况、要求或注意事项"
                />
              </label>
              <label>
                <span>跟进</span>
                <textarea
                  aria-label="记录跟进"
                  rows={4}
                  maxLength={4000}
                  value={value.followUp}
                  disabled={busy}
                  onChange={(e) => change('followUp', e.target.value)}
                  placeholder="记录最新进展与下一步安排"
                />
              </label>
            </form>
          ) : (
            <section
              id="record-history-panel"
              role="tabpanel"
              aria-labelledby="record-history-tab"
              className="record-history"
            >
              {base && <LegacySource kind="record" id={base.id} />}
              {base && (
                <dl className="record-provenance">
                  <div>
                    <dt>创建</dt>
                    <dd>
                      {base.createdName}
                      <time>{timestamp(base.createdAt)}</time>
                    </dd>
                  </div>
                  <div>
                    <dt>最后修改</dt>
                    <dd>
                      {latest?.updatedName ?? base.updatedName}
                      <time>{timestamp(latest?.updatedAt ?? base.updatedAt)}</time>
                    </dd>
                  </div>
                </dl>
              )}
              <p className="record-history-hint">
                操作人、时间与状态由服务端记录。正文仅记录修改字段，避免在历史中重复保留可能包含隐私的内容。
              </p>
              {historyBusy ? (
                <p role="status">正在读取历史…</p>
              ) : historyError ? (
                <p role="alert">{historyError}</p>
              ) : !history.length ? (
                <p>暂无可确认的历史</p>
              ) : (
                <ol>
                  {history.map((h) => (
                    <li key={h.id}>
                      <div>
                        <strong>{h.actorName}</strong>
                        <span>
                          {
                            { create: '创建记录', update: '修改记录', delete: '删除记录' }[
                              h.operation
                            ]
                          }
                        </span>
                      </div>
                      <time>{timestamp(h.at)}</time>
                      <p>{h.changedFields.map((f) => recordFields[f] ?? f).join('、')}</p>
                      {h.before?.status !== h.after?.status && (
                        <p>
                          状态：{h.before?.status ?? '无'} → {h.after?.status ?? '无'}
                        </p>
                      )}
                      {h.before?.nodeDate !== h.after?.nodeDate && (
                        <p>
                          节点日期：{h.before?.nodeDate || '未设置'} →{' '}
                          {h.after?.nodeDate || '未设置'}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
        <footer className="modal-foot record-drawer-foot">
          {base && (
            <button
              className="text-btn destructive"
              onClick={() => setDeleting(true)}
              disabled={busy}
            >
              <Trash2 size={15} />
              删除记录
            </button>
          )}
          <span>{changed ? '有未保存的修改' : base ? '已保存' : '填写后保存'}</span>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="record-form"
            disabled={busy || tab !== 'details' || (!!base && !changed)}
            className="primary"
          >
            {busy ? '正在保存…' : '保存记录'}
          </button>
        </footer>
      </Modal>
      {deleting && (
        <Confirm
          title="删除这条记录？"
          message={`「${base!.title}」将从看板移除，创建信息和操作历史继续保留。此操作不会删除项目、采购或施工任务。`}
          onCancel={() => {
            if (!busy) setDeleting(false);
          }}
          onConfirm={() => void save(true)}
        />
      )}
      {reloadConfirm && (
        <Confirm
          title="重新读取并放弃当前草稿？"
          message="已保存版本将替换当前编辑内容。其他项目及记录不受影响。"
          danger={false}
          onCancel={() => setReloadConfirm(false)}
          onConfirm={() => {
            setReloadConfirm(false);
            if (latest) {
              setBase(latest);
              setValue(recordData(latest));
              setError('');
              request.current = null;
            } else {
              onDirty(false);
              onSaved({ ...base!, deleted: true });
            }
          }}
        />
      )}
    </>
  );
}
