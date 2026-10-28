import { useEffect, useState, type FormEvent } from 'react';
import { cloudApi, type CloudUser } from '../lib/cloud';
import {
  cardEdit,
  managedCardEdit,
  departmentEdit,
  type MemberCard,
  type Department,
} from '../lib/member-cards';
import { Avatar } from './Avatar';
import { DateField } from './DateField';
import { Modal, Confirm } from './Modal';
import './member-cards.css';
export function MemberCards({
  user,
  onSaved,
}: {
  user: CloudUser;
  onSaved: (card: MemberCard) => Promise<void>;
}) {
  const [cards, setCards] = useState<MemberCard[]>([]),
    [departments, setDepartments] = useState<Department[]>([]),
    [editing, setEditing] = useState<MemberCard | null>(null),
    [draft, setDraft] = useState({
      displayName: '',
      englishName: '',
      joinedOn: '',
      departmentId: '',
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [manage, setManage] = useState(false),
    [department, setDepartment] = useState<Department | null>(null),
    [removing, setRemoving] = useState<Department | null>(null);
  async function load() {
    const [c, d] = await Promise.all([
      cloudApi<{ cards: MemberCard[] }>('/member-cards'),
      cloudApi<{ departments: Department[] }>('/departments'),
    ]);
    setCards(c.cards);
    setDepartments(d.departments);
    return c.cards;
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [user.id, user.displayName, user.avatarVersion]);
  function edit(card: MemberCard) {
    setError('');
    setEditing(card);
    setDraft({
      displayName: card.displayName,
      englishName: card.englishName,
      joinedOn: card.joinedOn ?? '',
      departmentId: card.departmentId ?? '',
    });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const b = {
        displayName: draft.displayName,
        englishName: draft.englishName,
        joinedOn: draft.joinedOn,
      };
      const body = user.owner
        ? managedCardEdit.parse({ ...b, departmentId: draft.departmentId || null })
        : cardEdit.parse(b);
      await cloudApi(user.owner ? '/member-cards/' + editing.id : '/member-cards/me', 'PUT', body);
      const fresh = await load();
      const card = fresh.find((c) => c.id === editing.id)!;
      await onSaved(card);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveDepartment(e: FormEvent) {
    e.preventDefault();
    if (!department) return;
    setBusy(true);
    setError('');
    try {
      const body = departmentEdit.parse({
        name: department.name,
        englishName: department.englishName,
        active: department.active,
      });
      await cloudApi(
        '/departments' + (department.id ? '/' + department.id : ''),
        department.id ? 'PUT' : 'POST',
        body,
      );
      await load();
      setDepartment(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="member-cards-section" aria-label="员工名片">
      <div className="section-heading">
        <h3>团队名片</h3>
        {user.owner && (
          <button
            onClick={() => {
              setManage(true);
              setError('');
            }}
          >
            部门管理
          </button>
        )}
      </div>
      <div className="member-cards-grid">
        {cards.map((card) => (
          <article className="member-card" key={card.id} data-member-id={card.id}>
            <div className="member-card-photo">
              <Avatar account={card} />
              {!card.active && <small className="member-card-inactive">账号已停用</small>}
            </div>
            <div className="member-card-content">
              <h3>{card.displayName}</h3>
              {card.englishName ? (
                <p className="member-card-english">{card.englishName}</p>
              ) : (
                <p className="member-card-english muted">英文名未设置</p>
              )}
              <div className="member-card-department">
                <p>{card.departmentName || '部门未设置'}</p>
                {card.departmentEnglishName && <p>{card.departmentEnglishName}</p>}
              </div>
              {(user.owner || user.id === card.id) && (
                <p className="member-card-joined">
                  入职日期 {card.joinedOn || '未设置'}
                  <small>仅本人和负责人可见</small>
                </p>
              )}
              <footer>
                <strong>
                  SJD<span className="brand-name">春茉</span>
                </strong>
                {(user.owner || user.id === card.id) && (
                  <button
                    className="text-btn"
                    aria-label={`编辑${card.displayName}名片`}
                    onClick={() => edit(card)}
                  >
                    编辑名片
                  </button>
                )}
              </footer>
            </div>
          </article>
        ))}
      </div>
      {error && !editing && !department && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <Modal
          title={`编辑名片 · ${editing.displayName}`}
          onClose={() => !busy && setEditing(null)}
          className="member-card-editor"
        >
          <form onSubmit={save}>
            <div className="modal-body form-grid">
              <label>
                中文姓名
                <input
                  aria-label="名片中文姓名"
                  required
                  maxLength={80}
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                />
              </label>
              <label>
                英文名
                <input
                  aria-label="名片英文名"
                  maxLength={80}
                  value={draft.englishName}
                  onChange={(e) => setDraft({ ...draft, englishName: e.target.value })}
                />
              </label>
              {user.owner ? (
                <label>
                  部门
                  <select
                    aria-label="名片部门"
                    value={draft.departmentId}
                    onChange={(e) => setDraft({ ...draft, departmentId: e.target.value })}
                  >
                    <option value="">未设置</option>
                    {departments
                      .filter((d) => d.active || d.id === editing.departmentId)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                          {!d.active ? '（已停用）' : ''}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <p className="form-info">部门由负责人设置：{editing.departmentName || '未设置'}</p>
              )}
              <DateField
                label="入职日期"
                value={draft.joinedOn}
                onChange={(joinedOn) => setDraft({ ...draft, joinedOn })}
              />
              <p className="muted span2">
                入职日期仅本人和负责人可见。姓名用于展示，不改变登录账号、角色或项目关联。头像在“账号与安全
                → 头像设置”修改。
              </p>
              {error && (
                <p className="error span2" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存名片
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {manage && (
        <Modal title="部门管理" onClose={() => setManage(false)}>
          <div className="modal-body">
            <div className="department-list">
              {departments.map((d) => (
                <div className="department-row" key={d.id}>
                  <span>
                    <strong>{d.name}</strong>
                    <small>
                      {d.englishName || '英文名称未设置'} · {d.members} 人 ·{' '}
                      {d.active ? '使用中' : '已停用'}
                    </small>
                  </span>
                  <button
                    onClick={() => {
                      setError('');
                      setDepartment({ ...d });
                    }}
                  >
                    编辑
                  </button>
                  <button className="destructive" onClick={() => setRemoving(d)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                setError('');
                setDepartment({ id: '', name: '', englishName: '', active: true, members: 0 });
              }}
            >
              新增部门
            </button>
            {error && !department && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setManage(false)}>关闭</button>
          </footer>
        </Modal>
      )}
      {department && (
        <Modal
          title={department.id ? '编辑部门' : '新增部门'}
          onClose={() => !busy && setDepartment(null)}
        >
          <form onSubmit={saveDepartment}>
            <div className="modal-body form-grid">
              <label>
                部门名称
                <input
                  aria-label="部门名称"
                  required
                  maxLength={60}
                  value={department.name}
                  onChange={(e) => setDepartment({ ...department, name: e.target.value })}
                />
              </label>
              <label>
                部门英文名称
                <input
                  aria-label="部门英文名称"
                  maxLength={100}
                  value={department.englishName}
                  onChange={(e) => setDepartment({ ...department, englishName: e.target.value })}
                />
              </label>
              <label className="check span2">
                <input
                  type="checkbox"
                  checked={department.active}
                  onChange={(e) => setDepartment({ ...department, active: e.target.checked })}
                />
                可分配新成员
              </label>
              {error && (
                <p className="error span2" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" onClick={() => setDepartment(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存部门
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {removing && (
        <Confirm
          title="删除部门？"
          message={`删除「${removing.name}」。有成员的部门不能删除，请先调整分配或停用。`}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            if (busy) return;
            setBusy(true);
            void cloudApi('/departments/' + removing.id, 'DELETE', {})
              .then(() => load())
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setBusy(false);
                setRemoving(null);
              });
          }}
        />
      )}
    </section>
  );
}
