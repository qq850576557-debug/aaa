import { useState, type FormEvent } from 'react';
import { id, type Data, type DictionaryItem } from '../lib/model';
import { saveDictionary, deleteDictionary, dictionaryReferences } from '../lib/dictionaries';
import { Modal, Confirm } from './Modal';
export function DictionaryPanel({
  data,
  onChange,
  onClose,
}: {
  data: Data;
  onChange: (fn: (d: Data) => Data) => void;
  onClose: () => void;
}) {
  const [edit, setEdit] = useState<DictionaryItem | null>(null),
    [remove, setRemove] = useState<DictionaryItem | null>(null),
    [error, setError] = useState(''),
    [search, setSearch] = useState('');
  const save = (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange((d) => saveDictionary(d, edit!));
      setEdit(null);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Modal title="人员类别与工种字典" onClose={onClose} className="history-panel">
      <div className="modal-body">
        <p>字典是业务分类，不是账号权限；逻辑状态与项目角色不会被删除。</p>
        <label>
          搜索选项
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="toolbar">
          <button
            onClick={() => {
              setError('');
              setEdit({
                id: id(),
                kind: 'category',
                label: '',
                active: true,
                order: (data.dictionaries ?? []).length,
              });
            }}
          >
            新增类别
          </button>
          <button
            onClick={() => {
              setError('');
              setEdit({
                id: id(),
                kind: 'trade',
                label: '',
                active: true,
                order: (data.dictionaries ?? []).length,
              });
            }}
          >
            新增工种选项
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {[...(data.dictionaries ?? [])]
          .filter((x) => !x.deleted && x.label.includes(search))
          .sort((a, b) => a.order - b.order)
          .map((x) => (
            <article className="dictionary-row" key={x.id} data-dictionary-id={x.id}>
              <strong>{x.label}</strong>
              <span>
                {x.kind === 'category' ? '人员类别' : '所属工种'} · {x.active ? '启用' : '停用'} ·
                引用 {dictionaryReferences(data, x.id).length} 人
              </span>
              <div className="toolbar">
                <button
                  onClick={() => {
                    setEdit(x);
                    setError('');
                  }}
                >
                  编辑选项
                </button>
                <button
                  onClick={() => onChange((d) => saveDictionary(d, { ...x, active: !x.active }))}
                >
                  {x.active ? '停用选项' : '启用选项'}
                </button>
                <button onClick={() => setRemove(x)}>删除选项</button>
              </div>
            </article>
          ))}
      </div>
      <footer className="modal-foot">
        <button onClick={onClose}>关闭</button>
      </footer>
      {edit && (
        <Modal title="编辑字典选项" onClose={() => setEdit(null)}>
          <form onSubmit={save}>
            <div className="modal-body">
              <label>
                选项名称
                <input
                  required
                  maxLength={100}
                  value={edit.label}
                  onChange={(e) => setEdit({ ...edit, label: e.target.value })}
                />
              </label>
              <label>
                排序
                <input
                  type="number"
                  min={0}
                  value={edit.order}
                  onChange={(e) => setEdit({ ...edit, order: Number(e.target.value) })}
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setEdit(null)}>
                取消
              </button>
              <button className="primary">保存选项</button>
            </footer>
          </form>
        </Modal>
      )}
      {remove && (
        <Confirm
          title="删除字典选项？"
          message={`删除「${remove.label}」前将检查人员引用。已使用的选项只能停用；无引用时保留删除标记和历史，不物理抹去ID。`}
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            try {
              onChange((d) => deleteDictionary(d, remove.id));
              setError('');
            } catch (e) {
              setError(String(e));
            }
            setRemove(null);
          }}
        />
      )}
    </Modal>
  );
}
