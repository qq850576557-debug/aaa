import { DateField } from './DateField';
import { useEffect, useState, type FormEvent } from 'react';
import { cloudApi } from '../lib/cloud';
import type { DirectoryAccount } from './CloudControl';
type AuditEvent = {
  id: string;
  actorId: string;
  actorDisplayName: string;
  createdAt: string;
  entityType: string;
  entityId: string;
  operation: string;
  before: unknown;
  after: unknown;
  changedFields?: string[];
  device: { category: string; os: string; browser: string; model: string; source: string };
};
const entities: Record<string, string> = {
  project: '项目',
  trade: '施工工种',
  task: '施工任务',
  purchase: '采购',
  note: '事项与备忘',
  person: '人员',
  dictionary: '标准字典',
  account: '账号',
  record: '看板记录',
};
const operations: Record<string, string> = { create: '新增', update: '修改', delete: '删除' };
const devices: Record<string, string> = { desktop: '电脑', mobile: '手机', tablet: '平板' };
const fields: Record<string, string> = {
  projectId: '关联项目编号',
  tradeId: '关联工种编号',
  taskId: '关联任务编号',
  groupId: '分段组编号',
  categoryId: '类别编号',
  name: '名称',
  title: '标题',
  label: '标签',
  address: '地址',
  owner: '负责人',
  manager: '项目经理',
  notes: '备注',
  content: '内容',
  personnel: '施工人员',
  quantity: '数量',
  specification: '规格',
  trade: '工种',
  start: '计划开始',
  end: '计划结束',
  actualStart: '实际开始',
  actualEnd: '实际结束',
  date: '日期',
  reminder: '提醒日期',
  due: '采购截止日期',
  originalDue: '原定截止日期',
  approvedDue: '已批准截止日期',
  updatedAt: '更新时间',
  status: '状态',
  role: '人员类别',
  kind: '事项类型',
  color: '工种颜色',
  defaultColor: '默认颜色',
  order: '顺序',
  position: '排列位置',
  leadDays: '采购提前天数',
  active: '已启用',
  archived: '已归档',
  done: '已完成',
  pinned: '已置顶',
  deleted: '已删除',
  deadlineMode: '期限规则',
  staffIds: '分配人员编号',
  tradeIds: '关联工种编号',
  dependsOn: '前序任务编号',
  displayName: '正式展示名称',
  avatar: '头像',
  login: '登录账号',
  loginChangedAt: '登录账号修改时间',
  nodeDate: '节点日期',
  followUp: '跟进',
};
function safeValue(value: unknown): string {
  if (value === null || value === undefined) return '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.map(safeValue).join('、') : '无';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function Snapshot({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return <p className="account-muted">无</p>;
  const entries = Object.entries(value);
  return entries.length ? (
    <dl className="audit-values">
      {entries.map(([field, value]) => (
        <div key={field}>
          <dt>{fields[field] || field}</dt>
          <dd>{safeValue(value)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="account-muted">没有可公开记录的字段值</p>
  );
}
export function AuditLog({ accounts }: { accounts: DirectoryAccount[] }) {
  const [actorId, setActor] = useState(''),
    [entityType, setEntity] = useState(''),
    [operation, setOperation] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [events, setEvents] = useState<AuditEvent[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(next?: string) {
    setBusy(true);
    setError('');
    try {
      if (from && to && from > to) throw Error('开始日期不能晚于结束日期');
      const query = new URLSearchParams({ limit: '30' });
      for (const [key, value] of Object.entries({ actorId, entityType, operation }))
        if (value) query.set(key, value);
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      if (next) query.set('cursor', next);
      const result = await cloudApi<{ events: AuditEvent[]; nextCursor: string | null }>(
        '/audit?' + query.toString(),
      );
      setEvents((old) => (next ? [...old, ...result.events] : result.events));
      setCursor(result.nextCursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setCursor(null);
  }, [actorId, entityType, operation, from, to]);
  return (
    <section className="account-section audit-log" aria-label="操作记录">
      <div>
        <h3>操作记录</h3>
        <p className="account-muted">
          记录由服务端生成，只读展示，时间按北京时间显示。仅记录允许的字段及登录账号变更；密码、私有备注和敏感个人资料不记录。设备信息来自浏览器声明，无法独立核验。
        </p>
      </div>
      <form
        className="audit-filters"
        aria-label="筛选操作记录"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          操作人
          <select aria-label="操作人" value={actorId} onChange={(e) => setActor(e.target.value)}>
            <option value="">全部账号</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName || a.login}
              </option>
            ))}
          </select>
        </label>
        <label>
          对象类型
          <select
            aria-label="对象类型"
            value={entityType}
            onChange={(e) => setEntity(e.target.value)}
          >
            <option value="">全部类型</option>
            {Object.entries(entities).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          操作类型
          <select
            aria-label="操作类型"
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
          >
            <option value="">全部操作</option>
            {Object.entries(operations).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <DateField label="开始日期" value={from} max={to || undefined} onChange={setFrom} />
        <DateField label="结束日期" value={to} min={from || undefined} onChange={setTo} />
        <button className="primary" disabled={busy}>
          筛选记录
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {busy && !events.length ? (
        <p role="status">正在读取操作记录…</p>
      ) : !events.length ? (
        <p className="account-empty">暂无符合条件的操作记录</p>
      ) : (
        <div className="audit-events" role="list" aria-label="操作记录列表">
          {events.map((event) => (
            <article role="listitem" key={event.id} className="audit-event">
              <div className="audit-event-heading">
                <strong>
                  {event.actorDisplayName || '未命名账号'} ·{' '}
                  {operations[event.operation] || event.operation}
                  {entities[event.entityType] || event.entityType}
                </strong>
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </time>
              </div>
              <p className="audit-object">
                审计对象编号：{event.entityId} <span>操作人ID：{event.actorId}</span>
              </p>
              <p className="audit-device">
                {devices[event.device?.category] || '设备类型未识别'} ·{' '}
                {event.device?.model || '型号未识别'} · {event.device?.os || '系统未识别'} ·{' '}
                {event.device?.browser || '浏览器未识别'}
              </p>
              <details>
                <summary>查看安全记录的变更</summary>
                {event.changedFields?.length ? (
                  <p>
                    涉及字段：
                    {event.changedFields.map((field) => fields[field] || field).join('、')}
                  </p>
                ) : null}
                <div className="audit-diff">
                  <div>
                    <h4>修改前</h4>
                    <Snapshot value={event.before} />
                  </div>
                  <div>
                    <h4>修改后</h4>
                    <Snapshot value={event.after} />
                  </div>
                </div>
              </details>
            </article>
          ))}
        </div>
      )}
      {cursor && (
        <button disabled={busy} onClick={() => void load(cursor)}>
          加载更多记录
        </button>
      )}
    </section>
  );
}
