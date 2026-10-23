import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { Confirm, Modal, type Anchor } from './Modal';
import { DateField } from './DateField';
import { ColorControls } from './ColorPopover';
import {
  dateOK,
  duration,
  plus,
  purchaseDue,
  projectSchema,
  tradeSchema,
  taskSchema,
  noteSchema,
  purchaseSchema,
  type Data,
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
}: {
  edit: Edit;
  data: Data;
  onClose: () => void;
  onSave: (kind: Edit['kind'], v: Entity) => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onContinue?: (t: Task) => void;
  onSegment?: (t: Task) => void;
}) {
  const [v, set] = useState<Record<string, unknown>>({ ...edit.value });
  const [error, setError] = useState('');
  const uid = useId();
  const [discard, setDiscard] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(edit.value);
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
    <label className="span2">
      {label}
      <textarea
        maxLength={4000}
        rows={3}
        value={String(v[key] ?? '')}
        onChange={(e) => change(key, e.target.value)}
      />
    </label>
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
      if (kind === 'note' && !payload.taskId) delete payload.taskId;
      const value = schemas[kind].parse(payload);
      onSave(kind, value);
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
    purchase: '采购记录',
  };
  let fields: ReactNode;
  if (kind === 'project')
    fields = (
      <>
        {input('name', '项目名称', 'text', true)}
        {select('status', '项目状态', ['筹备中', '进行中', '已完工', '暂停'])}
        {input('address', '项目地址')}
        {input('owner', '业主称呼')}
        {input('manager', '项目负责人')}
        {<div />}
        {input('start', '计划开工日期', 'date', true)}
        {input('end', '计划完工日期', 'date', true)}
        {input('actualStart', '实际开工日期', 'date')}
        {input('actualEnd', '实际完工日期', 'date')}
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
        {input('owner', '负责人')}
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
        <div />
        <div className="span2">
          <ColorControls
            color={String(v.color)}
            defaultColor={String(v.defaultColor)}
            recent={data.recentColors}
            onChange={(color) => change('color', color)}
          />
        </div>
      </>
    );
  else if (kind === 'note')
    fields = (
      <>
        {input('title', '事项标题', 'text', true)}
        {select('kind', '事项类型', [
          '施工安排',
          '材料采购',
          '业主确认',
          '现场复核',
          '到货验收',
          '其他事项',
          '项目备忘',
        ])}
        {input('date', '事项日期（备忘可留空）', 'date')}
        {input('reminder', '提醒日期', 'date')}
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
        {input('owner', '负责人')}
        <div />
        {select('taskId', '关联施工任务（可选）', [
          ['', '不关联任务'],
          ...data.tasks
            .filter((t) => t.projectId === v.projectId)
            .map((t) => [t.id, t.name] as [string, string]),
        ])}
        {area('content', '详细内容')}
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(v.done)}
            onChange={(e) => change('done', e.target.checked)}
          />
          已完成
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(v.pinned)}
            onChange={(e) => change('pinned', e.target.checked)}
          />
          置顶
        </label>
      </>
    );
  else
    fields = (
      <>
        {input('name', '材料 / 采购名称', 'text', true)}
        {select('status', '采购状态', ['待采购', '已下单', '已到货'])}
        {select('taskId', '关联施工任务（可选）', [
          ['', '不关联，使用指定截止日'],
          ...data.tasks
            .filter((t) => t.projectId === v.projectId)
            .map((t) => [t.id, t.name] as [string, string]),
        ])}
        {v.taskId ? (
          <label>
            开工前提前采购天数
            <input
              type="number"
              min={0}
              max={365}
              required
              value={Number(v.leadDays)}
              onChange={(e) => change('leadDays', Number(e.target.value))}
            />
          </label>
        ) : (
          input('due', '采购截止日期', 'date', true)
        )}
        {v.taskId && (
          <p className="form-info span2">
            动态采购截止日：{purchaseDue(v as unknown as Purchase, data)}。施工任务调整后自动更新。
          </p>
        )}
        {input('quantity', '采购数量（含单位）')}
        {input('specification', '材料规格')}
        {input('owner', '采购负责人')}
        {area('notes', '规格、数量与采购备注')}
      </>
    );
  return (
    <>
      {' '}
      <Modal
        title={`${isNew ? '新建' : '编辑'}${labels[kind]}`}
        subtitle="每一处细节，都让项目更有序。"
        onClose={close}
        anchor={edit.anchor}
        wide
      >
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="form-grid">{fields}</div>
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
