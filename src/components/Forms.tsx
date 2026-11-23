import { inCloud } from '../lib/cloud';
import { desktopV1Enabled } from '../ui-v1/mode';
import { PurchaseDateHistory } from './PurchaseDateHistory';
import { OwnerPurchaseFeedback } from './OwnerPurchaseControls';
import type { OwnerPurchaseItem, OwnerPurchaseProject } from '../lib/owner-purchases';
import { useEditorJournal } from '../lib/useEditorJournal';
import { useId, useRef, useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { Confirm, Modal, type Anchor } from './Modal';
import { DateField } from './DateField';
import { StaffPicker } from './StaffPicker';
import { ColorControls } from './ColorPopover';
import { MentionPicker } from './MentionPicker';
import { defaultTradeColor, resolvedTradeColor } from '../lib/trade-colors';
import {
  dateOK,
  duration,
  plus,
  purchaseComplete,
  purchaseDisplayStatus,
  purchaseDue,
  projectStatus,
  projectSchema,
  tradeSchema,
  taskSchema,
  noteSchema,
  purchaseSchema,
  purchaseStatuses,
  type Data,
  type Personnel,
  type Project,
  type Trade,
  type Task,
  type Note,
  type Purchase,
} from '../lib/model';
export type Edit = (
  | { kind: 'project'; value: Project }
  | { kind: 'trade'; value: Trade }
  | { kind: 'task'; value: Task }
  | { kind: 'note'; value: Note }
  | { kind: 'purchase'; value: Purchase }
) & { anchor?: Anchor };
export type Entity = Project | Trade | Task | Note | Purchase;
export function Editor({
  edit,
  data,
  onClose,
  onSave,
  onDelete,
  onCopy,
  onContinue,
  onSegment,
  onDeadlineChange,
  intro,
  embedded = false,
  onDirtyChange,
  onDraftChange,
  ownerPurchase,
}: {
  intro?: ReactNode;
  ownerPurchase?: {
    projects: OwnerPurchaseProject[];
    published: boolean;
    confirmed: boolean;
    founder: boolean;
    save: (
      purchase: Purchase,
      visible: boolean,
      edit?: { version?: string; changed: boolean },
      order?: { brand: string; model: string },
    ) => Promise<void>;
    refresh: () => void;
  };
  embedded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onDraftChange?: (value: Entity) => void;
  edit: Edit;
  data: Data;
  onClose: () => void;
  onSave: (kind: Edit['kind'], v: Entity, intent?: { colorChanged?: boolean }) => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onContinue?: (t: Task) => void;
  onSegment?: (t: Task) => void;
  onForgetName: (name: string) => void;
  onDeadlineChange?: (purchase: Purchase) => void;
}) {
  const initial = {
    ...edit.value,
    ...(edit.kind === 'project' ? { status: projectStatus(edit.value.status) } : {}),
    ...(edit.kind === 'purchase' ? { due: purchaseDue(edit.value, data) } : {}),
    ...(edit.kind === 'trade'
      ? {
          color: resolvedTradeColor(edit.value),
          defaultColor: edit.value.defaultColor,
        }
      : {}),
  };
  const [v, set] = useState<Record<string, unknown>>(initial);
  useEffect(() => onDraftChange?.(v as Entity), [v, onDraftChange]);
  const [error, setError] = useState('');
  const colorChanged = useRef(false);
  const uid = useId();
  const [discard, setDiscard] = useState(false);
  const [ownerDraft, setOwnerDraft] = useState<{
    project: string;
    visible: boolean;
    version?: string;
  }>();
  const [ownerItem, setOwnerItem] = useState<OwnerPurchaseItem>();
  const [savingOwnerPurchase, setSavingOwnerPurchase] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const collection = {
    project: data.projects,
    trade: data.trades,
    task: data.tasks,
    note: data.notes,
    purchase: data.purchases,
  }[edit.kind];
  const isExisting = collection.some(({ id }) => id === edit.value.id);
  const journal = useEditorJournal(
    `editor:${edit.kind}:${isExisting ? edit.value.id : 'new'}`,
    v,
    set,
    dirty,
    // A draft from a completed creation must not turn the next new purchase into an edit.
    edit.kind === 'purchase' && !isExisting
      ? (draft) =>
          typeof draft?.id === 'string' && !data.purchases.some(({ id }) => id === draft.id)
      : undefined,
  );
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const close = () => {
    if (!savingOwnerPurchase) {
      if (dirty || ownerDraft) setDiscard(true);
      else onClose();
    }
  };
  const [again, setAgain] = useState(false);
  const change = (key: string, value: unknown) =>
    set((old) => ({
      ...old,
      [key]: value,
      ...(edit.kind === 'task' && key === 'staffIds' ? { staffAssignment: 'explicit' } : {}),
    }));
  const dateChange = (key: string, value: string) =>
    set((old) => {
      if (
        edit.kind === 'task' &&
        key === 'start' &&
        dateOK(value) &&
        dateOK(String(old.start)) &&
        dateOK(String(old.end))
      )
        return {
          ...old,
          start: value,
          end: plus(value, duration(String(old.start), String(old.end)) - 1),
        };
      return { ...old, [key]: value };
    });
  const input = (key: string, label: string, type = 'text', required = false) =>
    type === 'date' ? (
      <DateField
        key={key}
        label={label}
        value={String(v[key] ?? '')}
        required={required}
        onChange={(date) => dateChange(key, date)}
        rangeStart={String(v.start ?? '')}
        rangeEnd={String(v.end ?? '')}
      />
    ) : (
      <div className="form-field" key={key}>
        <label htmlFor={`${uid}-${key}`}>{label}</label>
        <input
          id={`${uid}-${key}`}
          type={type}
          required={required}
          maxLength={
            key === 'orderBrand' || key === 'orderModel'
              ? 80
              : ['name', 'title', 'quantity'].includes(key)
                ? 100
                : 4000
          }
          value={String(v[key] ?? '')}
          onChange={(e) => change(key, e.target.value)}
        />
      </div>
    );
  const select = (key: string, label: string, options: (string | [string, string])[]) => (
    <div
      className={
        kind === 'purchase' && key === 'status' && canConfigureOwner
          ? 'form-field purchase-status-cell'
          : 'form-field'
      }
    >
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <select
        id={`${uid}-${key}`}
        data-purchase-status={
          kind === 'purchase' && key === 'status'
            ? purchaseDisplayStatus(v.status as Purchase['status'])
            : undefined
        }
        required={key === 'projectId'}
        disabled={kind === 'purchase' && key === 'status' && savingOwnerPurchase}
        value={
          key === 'dependency'
            ? String((v.dependsOn as string[] | undefined)?.[0] ?? '')
            : kind === 'purchase' && key === 'status'
              ? purchaseDisplayStatus(v.status as Purchase['status'])
              : String(v[key] ?? '')
        }
        onChange={(e) =>
          key === 'dependency'
            ? change('dependsOn', e.target.value ? [e.target.value] : [])
            : key === 'projectId' && kind === 'purchase'
              ? set((old) => ({
                  ...old,
                  projectId: e.target.value,
                  taskId: '',
                  deadlineMode: 'fixed',
                }))
              : change(key, e.target.value)
        }
      >
        {options.map((o) => {
          const [value, text] = Array.isArray(o) ? o : [o, o];
          return (
            <option
              key={value}
              value={value}
              disabled={
                edit.kind === 'purchase' &&
                key === 'status' &&
                canConfigureOwner &&
                value !== purchaseDisplayStatus(edit.value.status) &&
                (value === '已到货' ||
                  purchaseComplete(edit.value) ||
                  (edit.value.status === '已下单' && value === '待采购'))
              }
            >
              {text}
            </option>
          );
        })}
      </select>
    </div>
  );
  const area = (key: string, label: string) => (
    <div className="form-field span2">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <textarea
        id={`${uid}-${key}`}
        maxLength={4000}
        rows={3}
        value={String(v[key] ?? '')}
        onChange={(e) => change(key, e.target.value)}
      />
    </div>
  );
  const people = (v.personnel ?? {
    worker: edit.kind === 'task' ? String(v.owner ?? '') : '',
    manager: edit.kind === 'project' ? String(v.manager ?? '') : '',
    designer: '',
  }) as Personnel;
  const peopleFields = ['task', 'trade'].includes(edit.kind) && (
    <StaffPicker
      data={data}
      workersOnly={edit.kind === 'trade'}
      value={(v.staffIds as string[] | undefined) ?? []}
      onChange={(ids) => change('staffIds', ids)}
    />
  );
  const kind = edit.kind;
  const isNew = !collection.some(({ id }) => id === v.id);
  const schemas = {
    project: projectSchema,
    trade: tradeSchema,
    task: taskSchema,
    note: noteSchema,
    purchase: purchaseSchema,
  };
  const ownerProject = ownerPurchase?.projects.find(({ id }) => id === v.projectId);
  const canConfigureOwner = Boolean(
    ownerProject && (isNew || (edit.kind === 'purchase' && v.projectId === edit.value.projectId)),
  );
  const visibility = ownerDraft?.project === v.projectId ? ownerDraft : undefined;
  const published = ownerItem?.published ?? ownerPurchase?.published ?? false;
  const checked = visibility?.visible ?? published;
  const enteringOrder =
    kind === 'purchase' &&
    canConfigureOwner &&
    v.status === '已下单' &&
    (isNew || (edit.kind === 'purchase' && edit.value.status !== '已下单'));
  const refreshPublishedName =
    published && (!ownerItem || ownerItem.title !== ownerItem.internalTitle);
  const awaitingCloudPurchase = !isNew && ownerPurchase?.confirmed === false;
  function changeVisibility(visible: boolean) {
    if (!ownerProject) return;
    if (visible === published) {
      setOwnerDraft(undefined);
    } else {
      setOwnerDraft({
        project: ownerProject.id,
        visible,
        version: ownerItem?.version,
      });
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (savingOwnerPurchase) return;
    try {
      const { orderBrand, orderModel, ...payload } = v;
      const order = enteringOrder
        ? { brand: String(orderBrand ?? '').trim(), model: String(orderModel ?? '').trim() }
        : undefined;
      if (order && (!order.brand || !order.model)) throw Error('请填写品牌和型号');
      if (['project', 'trade', 'task'].includes(kind) && v.personnel) {
        payload.personnel = {
          ...people,
          ...(kind === 'task' ? { worker: String(v.owner ?? '') } : {}),
          ...(kind === 'project' ? { manager: String(v.manager ?? '') } : {}),
        };
      }
      if (kind === 'note' && !payload.taskId) delete payload.taskId;
      const value = schemas[kind].parse(payload);
      if (kind === 'purchase' && ownerDraft && (!visibility || !canConfigureOwner))
        throw Error('请在原项目保存业主可见性，再变更所属项目');
      if (
        kind === 'purchase' &&
        canConfigureOwner &&
        ownerPurchase &&
        (order ||
          visibility ||
          (checked && ownerProject?.enabled && (dirty || refreshPublishedName)))
      ) {
        const purchase = value as Purchase;
        const version = visibility ? visibility.version : ownerItem?.version;
        setSavingOwnerPurchase(true);
        await ownerPurchase.save(
          purchase,
          checked,
          isNew ? undefined : { version, changed: dirty },
          order,
        );
        await journal.clear().catch(() => {});
        ownerPurchase.refresh();
      } else {
        onSave(kind, value, { colorChanged: kind === 'trade' && colorChanged.current });
      }
      if (again && kind === 'task' && onContinue) {
        onContinue(value as Task);
      } else onClose();
    } catch (err) {
      setError(
        err instanceof z.ZodError
          ? err.issues.map((x) => x.message).join('；')
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSavingOwnerPurchase(false);
    }
  }
  const labels = {
    project: '项目',
    trade: '工种',
    task: '施工任务',
    note: v.kind === '项目备忘' ? '项目备忘' : '每日事项',
    purchase: '采购事项',
  };
  let fields: ReactNode;
  if (kind === 'project')
    fields = (
      <>
        {input('name', '项目名称', 'text', true)}
        {select('status', '项目状态', ['施工中', '已完工', '暂停'])}
        {input('owner', '业主称呼')}
        {input('start', '计划开工日期', 'date', true)}
        {input('end', '计划完工日期', 'date', true)}
        {area('notes', '项目备注')}
      </>
    );
  else if (kind === 'task')
    fields = (
      <>
        {input('name', '任务名称', 'text', true)}
        {select(
          'tradeId',
          '所属工种',
          data.trades
            .filter((g) => g.projectId === v.projectId)
            .sort((a, b) => a.order - b.order)
            .map((g) => [g.id, g.name]),
        )}
        {input('start', '开始日期', 'date', true)}
        {input('end', '结束日期', 'date', true)}
        <div className="form-info span2">
          自然日工期{' '}
          <strong>
            {v.end && v.start && v.end >= v.start ? duration(String(v.start), String(v.end)) : '—'}{' '}
            天
          </strong>{' '}
          · 包含开始与结束当天 · 允许交叉施工
          <span className="segment-info">
            同任务时间段：
            {Math.max(
              1,
              data.tasks.filter(
                (t) => t.projectId === v.projectId && (t.groupId ?? t.id) === (v.groupId ?? v.id),
              ).length + (isNew ? 1 : 0),
            )}{' '}
            段。新增时间段会保留逻辑关联。
          </span>
        </div>
        <label>
          持续天数
          <input
            aria-label="持续天数"
            type="number"
            min={1}
            max={1096}
            value={
              dateOK(String(v.start)) && dateOK(String(v.end))
                ? Math.max(1, duration(String(v.start), String(v.end)))
                : 1
            }
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 1 && n <= 1096 && dateOK(String(v.start)))
                change('end', plus(String(v.start), n - 1));
            }}
          />
        </label>
        {select('dependency', '前序任务（可选）', [
          ['', '无明确依赖'],
          ...data.tasks
            .filter((t) => t.projectId === v.projectId && t.id !== v.id)
            .map((t) => [t.id, t.name] as [string, string]),
        ])}
        {select('status', '任务状态', ['未开始', '进行中', '已完成', '已延期'])}
        {area('notes', '施工备注')}
        {isNew && (
          <label className="check span2">
            <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
            保存后继续创建下一段任务
          </label>
        )}
      </>
    );
  else if (kind === 'trade')
    fields = (
      <>
        {input('name', '工种名称', 'text', true)}
        <details className="span2 trade-colors" open={isNew}>
          <summary>
            工种颜色 <i style={{ background: String(v.color) }} /> <span>{String(v.color)}</span>
          </summary>
          <small>颜色仅用于当前项目的此施工阶段；不更改其他项目、日期或人员。</small>
          <ColorControls
            color={String(v.color)}
            defaultColor={defaultTradeColor(String(v.name)) || String(v.defaultColor)}
            recent={data.recentColors}
            onChange={(color) => {
              colorChanged.current = true;
              change('color', color);
            }}
          />
        </details>
      </>
    );
  else if (kind === 'note')
    fields = (
      <>
        {input('title', v.kind === '项目备忘' ? '备忘标题' : '事项标题', 'text', true)}
        {select(
          'projectId',
          '所属项目',
          data.projects.filter((p) => p.id === v.projectId).map((p) => [p.id, p.name]),
        )}
        {v.kind !== '项目备忘' && input('date', '计划日期', 'date', true)}
        {area('content', '详细备注（可选）')}
      </>
    );
  else
    fields = (
      <>
        {input('name', '采购名称', 'text', true)}
        {select(
          'projectId',
          '所属项目',
          data.projects.map((p) => [p.id, p.name]),
        )}
        {input('specification', '型号 / 规格')}
        {input('quantity', '数量')}
        {inCloud() ? (
          <MentionPicker
            owner={String(v.owner ?? '')}
            onOwnerChange={(text) => change('owner', text)}
            value={(v.mentionIds as string[] | undefined) ?? []}
            onChange={(ids) => change('mentionIds', ids)}
          />
        ) : (
          input('owner', '采购负责人')
        )}
        <div className="purchase-date-editor">
          {input('due', '最迟采购日期', 'date', true)}
          <PurchaseDateHistory purchase={edit.value as Purchase} />
        </div>
        {area('notes', '采购说明（内部）')}
        {canConfigureOwner ? (
          <div className="purchase-visibility-row span2">
            <label
              className="purchase-visibility-cell"
              title={!ownerProject?.enabled ? '项目的业主采购服务已关闭' : undefined}
            >
              <span>业主可见</span>
              <input
                type="checkbox"
                checked={checked}
                disabled={
                  savingOwnerPurchase ||
                  (!isNew && !awaitingCloudPurchase && !ownerItem && !visibility) ||
                  (!ownerProject?.enabled && !checked)
                }
                onChange={(event) => changeVisibility(event.target.checked)}
              />
            </label>
            {select('status', '采购状态', [...purchaseStatuses])}
          </div>
        ) : (
          select('status', '采购状态', [...purchaseStatuses])
        )}
        {enteringOrder && (
          <>
            {input('orderBrand', '品牌', 'text', true)}
            {input('orderModel', '型号', 'text', true)}
          </>
        )}
        {ownerPurchase && ownerProject && canConfigureOwner && !isNew && !awaitingCloudPurchase && (
          <OwnerPurchaseFeedback
            project={ownerProject.id}
            id={edit.value.id}
            founder={ownerPurchase.founder}
            dirty={dirty || !!visibility}
            onChanged={ownerPurchase.refresh}
            onLoaded={setOwnerItem}
            saving={savingOwnerPurchase}
          />
        )}
      </>
    );
  return (
    <>
      {' '}
      <Modal
        inline={embedded}
        title={`${isNew ? '新建' : '编辑'}${labels[kind]}`}
        subtitle={
          kind === 'trade' || desktopV1Enabled() ? undefined : '每一处细节，都让项目更有序。'
        }
        onClose={close}
        anchor={edit.anchor}
        wide={kind !== 'trade' && kind !== 'project'}
        className={
          kind === 'trade'
            ? 'trade-editor'
            : kind === 'project'
              ? 'project-editor'
              : kind === 'purchase'
                ? 'purchase-editor'
                : ''
        }
      >
        <form onSubmit={submit}>
          <div className="modal-body" inert={savingOwnerPurchase}>
            {intro}
            <div className="form-grid">
              {kind === 'trade' && peopleFields}
              {fields}
              {kind === 'task' && (
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label="跟随工种当前人员"
                    checked={v.staffAssignment === 'inherit' || v.staffIds === undefined}
                    onChange={(e) =>
                      set((old) => ({
                        ...old,
                        staffAssignment: e.target.checked ? 'inherit' : 'explicit',
                        staffIds: e.target.checked ? undefined : (old.staffIds ?? []),
                      }))
                    }
                  />
                  跟随工种当前人员（取消后独立分配）
                </label>
              )}
              {kind !== 'trade' && peopleFields}
            </div>
            {journal.status && <p role="status">{journal.status}</p>}
            {!!journal.recovery && (
              <details>
                <summary>查看保留的本地恢复副本</summary>
                <pre>{JSON.stringify(journal.recovery, null, 2)}</pre>
              </details>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <div className="left-actions">
              {onDelete && (
                <button
                  type="button"
                  className="text-btn destructive"
                  disabled={savingOwnerPurchase}
                  onClick={onDelete}
                >
                  删除
                </button>
              )}
              {onCopy && (
                <button
                  type="button"
                  onClick={() => {
                    if (dirty) {
                      setError('请先保存当前修改，再复制。');
                      return;
                    }
                    onCopy();
                  }}
                >
                  复制
                </button>
              )}
            </div>
            {kind === 'purchase' && !isNew && onDeadlineChange && (
              <button
                type="button"
                disabled={savingOwnerPurchase}
                onClick={() => {
                  if (dirty) {
                    setError('请先保存当前修改，再变更原定期限。');
                    return;
                  }
                  onDeadlineChange(edit.value as Purchase);
                }}
              >
                变更原定期限
              </button>
            )}
            <button type="button" onClick={close}>
              取消
            </button>
            {onSegment && kind === 'task' && !isNew && (
              <button
                type="button"
                onClick={() => {
                  if (dirty) {
                    setError('请先保存当前修改，再新增时间段。');
                    return;
                  }
                  onSegment(edit.value as Task);
                }}
              >
                新增时间段
              </button>
            )}
            <button type="submit" className="primary" disabled={savingOwnerPurchase}>
              {again ? '保存并继续' : '保存'}
            </button>
          </footer>
        </form>
      </Modal>
      {discard && (
        <Confirm
          title="放弃未保存的修改？"
          message="当前表单有尚未保存的内容。返回可继续编辑，确认后丢弃本次表单修改。"
          onCancel={() => setDiscard(false)}
          onConfirm={onClose}
        />
      )}
    </>
  );
}
export const nextTask = (t: Task): Task => ({
  ...t,
  start: plus(t.end, 1),
  end: plus(t.end, duration(t.start, t.end)),
});
