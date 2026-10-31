import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { Confirm, Modal, type Anchor } from './Modal';
import { DateField } from './DateField';
import { StaffPicker } from './StaffPicker';
import { ColorControls } from './ColorPopover';
import { defaultTradeColor, resolvedTradeColor } from '../lib/trade-colors';
import {
  dateOK,
  duration,
  plus,
  purchaseDue,
  purchaseCeiling,
  projectStatus,
  projectSchema,
  tradeSchema,
  taskSchema,
  noteSchema,
  purchaseSchema,
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
}: {
  intro?: ReactNode;
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
  const [error, setError] = useState('');
  const colorChanged = useRef(false);
  const uid = useId();
  const [discard, setDiscard] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const close = () => (dirty ? setDiscard(true) : onClose());
  const [again, setAgain] = useState(false);
  const change = (key: string, value: unknown) => set((old) => ({ ...old, [key]: value }));
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
        max={
          edit.kind === 'purchase' && data.purchases.some((p) => p.id === v.id)
            ? purchaseCeiling(edit.value as Purchase, data)
            : undefined
        }
      />
    ) : (
      <div className="form-field" key={key}>
        <label htmlFor={`${uid}-${key}`}>{label}</label>
        <input
          id={`${uid}-${key}`}
          type={type}
          required={required}
          maxLength={['name', 'title'].includes(key) ? 100 : 4000}
          value={String(v[key] ?? '')}
          onChange={(e) => change(key, e.target.value)}
        />
      </div>
    );
  const select = (key: string, label: string, options: (string | [string, string])[]) => (
    <div className="form-field">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <select
        id={`${uid}-${key}`}
        value={
          key === 'dependency'
            ? String((v.dependsOn as string[] | undefined)?.[0] ?? '')
            : String(v[key] ?? '')
        }
        onChange={(e) =>
          key === 'dependency'
            ? change('dependsOn', e.target.value ? [e.target.value] : [])
            : change(key, e.target.value)
        }
      >
        {options.map((o) => {
          const [value, text] = Array.isArray(o) ? o : [o, o];
          return (
            <option key={value} value={value}>
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
  const isNew = !{
    project: data.projects,
    trade: data.trades,
    task: data.tasks,
    note: data.notes,
    purchase: data.purchases,
  }[kind].some((x) => x.id === v.id);
  const schemas = {
    project: projectSchema,
    trade: tradeSchema,
    task: taskSchema,
    note: noteSchema,
    purchase: purchaseSchema,
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const payload = { ...v };
      if (['project', 'trade', 'task'].includes(kind) && v.personnel) {
        payload.personnel = {
          ...people,
          ...(kind === 'task' ? { worker: String(v.owner ?? '') } : {}),
          ...(kind === 'project' ? { manager: String(v.manager ?? '') } : {}),
        };
      }
      if (kind === 'note' && !payload.taskId) delete payload.taskId;
      const value = schemas[kind].parse(payload);
      onSave(kind, value, { colorChanged: kind === 'trade' && colorChanged.current });
      if (again && kind === 'task' && onContinue) {
        onContinue(value as Task);
      } else onClose();
    } catch (err) {
      setError(
        err instanceof z.ZodError ? err.issues.map((x) => x.message).join('；') : String(err),
      );
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
        {input('name', '采购内容 / 事项标题', 'text', true)}
        <p className="form-info span2">
          所属项目：{data.projects.find((p) => p.id === v.projectId)?.name}
        </p>
        {input('specification', '规格型号')}
        {input('owner', '采购负责人')}
        {input('due', '采购截止日期', 'date', true)}
        {select('status', '采购状态', ['待采购', '已下单', '已到货', '已完成'])}
        {area('notes', '详细备注（可选）')}
        {!isNew && (
          <div className="form-info span2">
            原始截止：
            {(edit.value as Purchase).originalDue ?? purchaseDue(edit.value as Purchase, data)}
            ；普通编辑最晚：{purchaseCeiling(edit.value as Purchase, data)}。
            {(edit.value as Purchase).taskId && (
              <span>已有关联保留。手动修改截止日后采用固定采购计划，施工日期不会因此顺延。</span>
            )}
            {!!(edit.value as Purchase).deadlineHistory?.length && (
              <details>
                <summary>期限变更记录</summary>
                {(edit.value as Purchase).deadlineHistory!.map((h, i) => (
                  <p key={i}>
                    {h.from} → {h.to} · {h.reason} · {h.at}
                  </p>
                ))}
              </details>
            )}
          </div>
        )}
      </>
    );
  return (
    <>
      {' '}
      <Modal
        title={`${isNew ? '新建' : '编辑'}${labels[kind]}`}
        subtitle={kind === 'trade' ? undefined : '每一处细节，都让项目更有序。'}
        onClose={close}
        anchor={edit.anchor}
        wide={kind !== 'trade' && kind !== 'project'}
        className={kind === 'trade' ? 'trade-editor' : kind === 'project' ? 'project-editor' : ''}
      >
        <form onSubmit={submit}>
          <div className="modal-body">
            {intro}
            <div className="form-grid">
              {kind === 'trade' && peopleFields}
              {fields}
              {kind !== 'trade' && peopleFields}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <div className="left-actions">
              {onDelete && (
                <button type="button" className="text-btn destructive" onClick={onDelete}>
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
            <button type="submit" className="primary">
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
