import { useState, type FormEvent } from 'react';
import type { Data } from '../lib/model';
import {
  workerTradeChoices,
  workerReferences,
  saveWorkerTrade,
  removeWorkerTrade,
  reorderWorkerTrades,
  isWorkerTrade,
} from '../lib/worker-trades';
import { Modal, Confirm } from './Modal';
import { ArrowUp, ArrowDown, Plus } from 'lucide-react';

// Reuses the existing workspace dictionary, IDs, order and soft-state fields.
export function DictionaryPanel({
  data,
  onChange,
  onClose,
}: {
  data: Data;
  onChange: (fn: (d: Data) => Data) => void;
  onClose: () => void;
}) {
  const [edit, setEdit] = useState<{
    id?: string;
    label: string;
    active: boolean;
    order: number;
  } | null>(null);
  const [remove, setRemove] = useState<string | null>(null),
    [error, setError] = useState(''),
    [search, setSearch] = useState('');
  const choices = workerTradeChoices(data).filter((x) => !x.deleted);
  function action(fn: (d: Data) => Data) {
    try {
      onChange(fn);
      setError('');
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }
  function save(e: FormEvent) {
    e.preventDefault();
    if (edit && action((d) => saveWorkerTrade(d, edit, edit.id))) setEdit(null);
  }
  const removing = choices.find((x) => x.id === remove);
  const used = removing ? workerReferences(data, removing.ids).length : 0;
  const legacy = (data.dictionaries ?? []).filter(
    (x) => x.kind === 'trade' && !isWorkerTrade(data, x),
  );
  return (
    <Modal title="人员工种管理" onClose={onClose} className="worker-trade-manager">
      <div className="modal-body">
        <p>这里管理人员的技能工种；施工阶段与任务仍在施工时间轴安排。改名保留原 ID 和人员关联。</p>
        <div className="worker-picker-tools">
          <input
            aria-label="搜索工种管理"
            placeholder="搜索工种"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="primary"
            onClick={() => {
              setError('');
              setEdit({
                label: '',
                active: true,
                order: Math.max(-1, ...choices.map((x) => x.order)) + 1,
              });
            }}
          >
            <Plus size={14} />
            新增工种
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="worker-manager-list">
          {choices
            .filter((x) => x.label.includes(search.trim()))
            .map((x) => {
              const i = choices.findIndex((item) => item.id === x.id);
              return (
                <article className="dictionary-row" key={x.id} data-dictionary-id={x.id}>
                  <div>
                    <strong>{x.label}</strong>
                    <small>
                      {x.active ? '启用' : '停用'} · 已关联 {workerReferences(data, x.ids).length}{' '}
                      人
                    </small>
                  </div>
                  <div className="toolbar">
                    <button
                      aria-label={`上移工种${x.label}`}
                      disabled={i === 0}
                      onClick={() => action((d) => reorderWorkerTrades(d, x.id, choices[i - 1].id))}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      aria-label={`下移工种${x.label}`}
                      disabled={i === choices.length - 1}
                      onClick={() =>
                        action((d) => reorderWorkerTrades(d, x.id, choices[i + 2]?.id ?? null))
                      }
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setError('');
                        setEdit(x);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() =>
                        action((d) => saveWorkerTrade(d, { ...x, active: !x.active }, x.id))
                      }
                    >
                      {x.active ? '停用' : '启用'}
                    </button>
                    <button
                      className="destructive"
                      aria-label={`删除工种${x.label}`}
                      onClick={() => setRemove(x.id)}
                    >
                      删除
                    </button>
                  </div>
                </article>
              );
            })}
        </div>
        {legacy.length > 0 && (
          <details>
            <summary>历史施工阶段关联 · {legacy.length}</summary>
            <p>以下旧条目不会出现在新的人员工种候选中，原 ID、人员和历史引用仍保留。</p>
            {legacy.map((x) => (
              <p key={x.id}>
                {x.label} · 引用 {workerReferences(data, [x.id]).length} 人
              </p>
            ))}
          </details>
        )}
      </div>
      <footer className="modal-foot">
        <button onClick={onClose}>关闭</button>
      </footer>
      {edit && (
        <Modal title={edit.id ? '编辑人员工种' : '新增人员工种'} onClose={() => setEdit(null)}>
          <form onSubmit={save}>
            <div className="modal-body form-grid">
              <label className="span2">
                工种名称
                <input
                  aria-label="人员工种名称"
                  required
                  maxLength={100}
                  value={edit.label}
                  onChange={(e) => setEdit({ ...edit, label: e.target.value })}
                />
              </label>
              <label>
                显示顺序
                <input
                  aria-label="工种显示顺序"
                  type="number"
                  min={0}
                  required
                  value={edit.order}
                  onChange={(e) => setEdit({ ...edit, order: Number(e.target.value) })}
                />
              </label>
              {error && (
                <p className="error span2" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setEdit(null)}>
                取消
              </button>
              <button className="primary">保存工种</button>
            </footer>
          </form>
        </Modal>
      )}
      {removing && (
        <Confirm
          title={used ? '此工种已被使用，改为停用？' : '删除未使用的工种？'}
          message={
            used
              ? `「${removing.label}」已关联 ${used} 人，将仅停用新增选择；已有人员、项目和历史关联全部保留。`
              : `「${removing.label}」将保留删除标记和历史，不物理删除记录。`
          }
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            action((d) => removeWorkerTrade(d, removing.id));
            setRemove(null);
          }}
        />
      )}
    </Modal>
  );
}
