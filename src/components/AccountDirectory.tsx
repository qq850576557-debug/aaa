import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Ellipsis, Plus } from 'lucide-react';
import { cloudApi, CloudError, type CloudUser } from '../lib/cloud';
import type { MemberCard } from '../lib/member-cards';
import { LOGIN_HELP } from '../lib/login';
import { PASSWORD_MAX, PASSWORD_MIN } from '../lib/password';
import { Avatar } from './Avatar';
import { MemberCards } from './MemberCards';
import { Modal } from './Modal';
import { useProjectThemeStyles } from './ProjectThemes';
import './account-directory.css';

type Staff = MemberCard & { phoneSuffix?: string; bound?: boolean; note?: string };
type Project = { id: string; name: string; enabled: boolean };
type OwnerMember = {
  id: string;
  name: string;
  maskedPhone: string;
  bound: boolean;
  projects: (Project & { active: boolean })[];
};
type OwnerDirectory = { members: OwnerMember[]; projects: Project[] };

function More({ name, children }: { name: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="directory-action">
      <button
        type="button"
        className="directory-more"
        popoverTarget={id}
        aria-haspopup="true"
        aria-label={name + '的操作'}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      <div
        id={id}
        popover="auto"
        className="directory-menu"
        aria-label={name + '的操作'}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) event.currentTarget.hidePopover();
        }}
      >
        {children}
      </div>
    </div>
  );
}

type Dialog = { title: string; body: ReactNode };
type StaffAction =
  'card' | 'edit' | 'password' | 'status' | 'phone' | 'unlink' | 'permissions' | 'note';
type OwnerAction = 'grant' | 'revoke' | 'rebind';

export function AccountDirectory({
  user,
  category,
  onProfile,
}: {
  user: CloudUser;
  category: 'staff' | 'owner';
  onProfile: (card: MemberCard) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [projectFilter, filter] = useState('');
  const [people, setPeople] = useState<Staff[]>([]);
  const [ownerDirectory, setOwners] = useState<OwnerDirectory>({ members: [], projects: [] });
  const [staffBindings, setStaffBindings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<
    | 'department'
    | 'create'
    | { staff: Staff; action: StaffAction }
    | { member?: OwnerMember; action: OwnerAction }
  >();
  const theme = useProjectThemeStyles();
  async function load() {
    if (category === 'owner') {
      setOwners(await cloudApi<OwnerDirectory>('/owner-accounts'));
      return;
    }
    const [cards, directory, binding] = await Promise.all([
      cloudApi<{ cards: MemberCard[] }>('/member-cards'),
      cloudApi<{ accounts: { id: string; note: string }[] }>('/directory'),
      user.owner
        ? cloudApi<{ accounts: { id: string; phoneSuffix?: string; bound: boolean }[] }>(
            '/accounts/wechat',
          ).catch((e) => {
            if (e instanceof CloudError && e.status === 404) return null;
            throw e;
          })
        : null,
    ]);
    const notes = new Map(directory.accounts.map((a) => [a.id, a.note]));
    const bindings = new Map(binding?.accounts.map((a) => [a.id, a]));
    setStaffBindings(Boolean(binding));
    setPeople(
      cards.cards.map((card) => ({ ...card, ...bindings.get(card.id), note: notes.get(card.id) })),
    );
  }
  useEffect(() => {
    void load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [user.id, category]);
  function refresh(message = '已保存') {
    setDialog(undefined);
    setNotice(message);
    return load().catch((e) => setError(e.message));
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...parts: (string | null | undefined)[]) =>
    parts.some((value) => value?.toLocaleLowerCase().includes(needle));
  const staffRows = people.filter((a) =>
    matches(a.displayName, a.login, a.departmentName, a.jobTitle, a.phoneSuffix),
  );
  const ownerRows = ownerDirectory.members.filter(
    (m) =>
      (!projectFilter || m.projects.some((p) => p.id === projectFilter)) &&
      matches(m.name, m.maskedPhone, ...m.projects.map((p) => p.name)),
  );
  const isStaff = category === 'staff';
  const close = () => setDialog(undefined);

  return (
    <section className="account-directory" aria-label={isStaff ? '员工账号' : '业主账号'}>
      <div className="directory-toolbar">
        <input
          type="search"
          aria-label="搜索账号"
          value={query}
          placeholder={isStaff ? '搜索姓名、部门、账号…' : '搜索姓名、手机号尾号、工地…'}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!isStaff && (
          <select
            aria-label="按工地筛选"
            value={projectFilter}
            onChange={(e) => filter(e.target.value)}
          >
            <option value="">全部工地</option>
            {ownerDirectory.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {user.owner && !error && (
          <>
            {isStaff && <button onClick={() => setDialog('department')}>部门管理</button>}
            <button
              className="primary"
              onClick={() => setDialog(isStaff ? 'create' : { action: 'grant' })}
            >
              <Plus size={14} aria-hidden="true" />
              {isStaff ? '新增账号' : '新增授权'}
            </button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="directory-state">
          {error}
        </p>
      ) : loading ? (
        <p role="status" className="directory-state">
          正在读取账号…
        </p>
      ) : (
        <div className="directory-table-wrap">
          <table className="directory-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>{isStaff ? '部门 / 职务' : '关联工地'}</th>
                <th>手机号</th>
                {isStaff && <th>权限</th>}
                <th>微信绑定</th>
                <th>{isStaff ? '账号状态' : '授权状态'}</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {isStaff
                ? staffRows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <button
                          className="directory-person"
                          aria-label={a.displayName}
                          onClick={() => setDialog({ staff: a, action: 'card' })}
                        >
                          <Avatar account={a} />
                          <span>{a.displayName}</span>
                        </button>
                      </td>
                      <td>{[a.departmentName, a.jobTitle].filter(Boolean).join(' / ') || '—'}</td>
                      <td>{a.phoneSuffix ? '•••••••' + a.phoneSuffix : '—'}</td>
                      <td>{a.owner ? '最高负责人' : '普通员工'}</td>
                      <td className={a.bound ? 'directory-positive' : 'directory-muted'}>
                        {staffBindings ? (a.bound ? '已绑定' : '待绑定') : '—'}
                      </td>
                      <td>{a.active ? '启用' : '已停用'}</td>
                      <td>
                        <More name={a.displayName}>
                          {(user.owner || user.id === a.id) && (
                            <button onClick={() => setDialog({ staff: a, action: 'edit' })}>
                              编辑名片
                            </button>
                          )}
                          {user.id !== a.id && (
                            <button onClick={() => setDialog({ staff: a, action: 'note' })}>
                              我的私有备注
                            </button>
                          )}
                          {user.owner && (
                            <>
                              {!a.owner && (
                                <button
                                  onClick={() => setDialog({ staff: a, action: 'permissions' })}
                                >
                                  工地权限
                                </button>
                              )}
                              {staffBindings && (
                                <button onClick={() => setDialog({ staff: a, action: 'phone' })}>
                                  设置绑定手机号
                                </button>
                              )}
                              {staffBindings && a.bound && (
                                <button onClick={() => setDialog({ staff: a, action: 'unlink' })}>
                                  解除绑定 / 重新绑定
                                </button>
                              )}
                              {!a.owner && (
                                <>
                                  <button
                                    onClick={() => setDialog({ staff: a, action: 'password' })}
                                  >
                                    重置密码
                                  </button>
                                  <button onClick={() => setDialog({ staff: a, action: 'status' })}>
                                    {a.active ? '停用 / 离职' : '恢复账号'}
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </More>
                      </td>
                    </tr>
                  ))
                : ownerRows.map((m) => {
                    const active = m.projects.filter((p) => p.active);
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="directory-person">
                            <Avatar account={{ id: m.id, login: m.name }} />
                            <span>{m.name}</span>
                          </div>
                        </td>
                        <td>
                          <div className="directory-tags">
                            {m.projects.map((p) => (
                              <span
                                key={p.id}
                                style={theme(p.id)}
                                data-revoked={!p.active}
                                title={p.name || p.id}
                              >
                                {p.name || '已归档工地'}
                                {p.active ? '' : ' · 已撤销'}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>{m.maskedPhone}</td>
                        <td className={m.bound ? 'directory-positive' : 'directory-muted'}>
                          {m.bound ? '已绑定' : '待绑定'}
                        </td>
                        <td>
                          {active.some((p) => p.enabled)
                            ? '已授权'
                            : active.length
                              ? '工地服务关闭'
                              : '已撤销'}
                        </td>
                        <td>
                          <More name={m.name}>
                            <button onClick={() => setDialog({ member: m, action: 'grant' })}>
                              关联工地 / 发邀请
                            </button>
                            {active.length > 0 && (
                              <>
                                <button onClick={() => setDialog({ member: m, action: 'rebind' })}>
                                  重新绑定微信
                                </button>
                                <button onClick={() => setDialog({ member: m, action: 'revoke' })}>
                                  撤销工地授权
                                </button>
                              </>
                            )}
                          </More>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
          {!(isStaff ? staffRows.length : ownerRows.length) && (
            <p className="directory-state">没有符合条件的账号</p>
          )}
        </div>
      )}
      <div className="directory-announcer" role="status">
        {notice}
      </div>
      {dialog === 'department' && (
        <MemberCards
          user={user}
          onSaved={onProfile}
          compactAction="department"
          onCompactClose={close}
        />
      )}
      {dialog === 'create' && (
        <DirectoryForm
          title="新增员工账号"
          onClose={close}
          submitLabel="创建员工"
          onSubmit={async (values) => {
            await cloudApi('/accounts', 'POST', {
              login: values.login,
              password: values.password,
              displayName: values.name,
            });
            await refresh('员工账号已创建');
          }}
        >
          <label>
            员工姓名
            <input name="name" required maxLength={80} />
          </label>
          <label>
            员工登录名
            <input
              name="login"
              autoComplete="off"
              required
              minLength={3}
              maxLength={160}
              placeholder={LOGIN_HELP}
            />
          </label>
          <label>
            初始密码
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
            />
          </label>
        </DirectoryForm>
      )}
      {dialog &&
        typeof dialog === 'object' &&
        ('staff' in dialog ? (
          <StaffEditor
            user={user}
            {...dialog}
            onClose={close}
            refresh={refresh}
            onProfile={onProfile}
          />
        ) : (
          <OwnerEditor
            {...dialog}
            projects={ownerDirectory.projects}
            onClose={close}
            refresh={refresh}
          />
        ))}
    </section>
  );
}

function StaffEditor({
  user,
  staff,
  action,
  onClose,
  refresh,
  onProfile,
}: {
  user: CloudUser;
  staff: Staff;
  action: StaffAction;
  onClose: () => void;
  refresh: (message?: string) => Promise<void>;
  onProfile: (card: MemberCard) => Promise<void>;
}) {
  if (action === 'card')
    return (
      <Modal
        title={staff.displayName}
        onClose={onClose}
        animateClose
        compactHeader
        className="directory-card-dialog"
      >
        <div className="modal-body">
          <MemberCards user={user} onlyId={staff.id} readOnly onSaved={onProfile} />
        </div>
      </Modal>
    );
  if (action === 'edit')
    return (
      <MemberCards
        user={user}
        onlyId={staff.id}
        compactAction="edit"
        onCompactClose={onClose}
        onSaved={async (card) => {
          await onProfile(card);
          await refresh('名片已保存');
        }}
      />
    );
  const base = '/accounts/' + encodeURIComponent(staff.id);
  if (action === 'permissions')
    return (
      <ProjectPermissions
        url={base + '/project-permissions'}
        onClose={onClose}
        name={staff.displayName}
      />
    );
  const editors: Record<Exclude<StaffAction, 'card' | 'edit' | 'permissions'>, Dialog> = {
    password: {
      title: '重置员工密码',
      body: (
        <label>
          新密码
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
          />
        </label>
      ),
    },
    status: {
      title: staff.active ? '停用员工账号' : '恢复员工账号',
      body: staff.active ? (
        <>
          <p>停用后立即撤销该员工会话和微信绑定。</p>
          <label>
            停用原因
            <select name="reason">
              <option value="">普通停用</option>
              <option value="departure">员工离职</option>
            </select>
          </label>
        </>
      ) : (
        <p>恢复后员工可以用密码登录，并重新绑定微信。</p>
      ),
    },
    phone: {
      title: '设置绑定手机号',
      body: (
        <label>
          员工手机号
          <input
            name="phone"
            type="tel"
            autoComplete="off"
            pattern="1[3-9][0-9]{9}"
            required
            maxLength={11}
          />
        </label>
      ),
    },
    unlink: {
      title: '解除微信绑定',
      body: <p>将立即撤销该员工的现有会话。员工可用原账号密码和已登记手机号重新绑定。</p>,
    },
    note: {
      title: '我的私有备注',
      body: (
        <label>
          仅自己可见
          <textarea name="note" maxLength={1000} rows={3} defaultValue={staff.note} />
        </label>
      ),
    },
  };
  const picked = editors[action];
  return (
    <DirectoryForm
      title={picked.title + ' · ' + staff.displayName}
      onClose={onClose}
      onSubmit={async (values) => {
        if (action === 'phone')
          await cloudApi(base + '/wechat', 'PUT', { action: 'set-phone', phone: values.phone });
        if (action === 'unlink') await cloudApi(base + '/wechat', 'PUT', { action: 'unlink' });
        if (action === 'password') await cloudApi(base, 'PATCH', { password: values.password });
        if (action === 'status')
          await cloudApi(base, 'PATCH', {
            active: !staff.active,
            ...(staff.active && values.reason === 'departure' ? { reason: values.reason } : {}),
          });
        if (action === 'note') await cloudApi(base + '/note', 'PUT', { note: values.note });
        await refresh();
      }}
    >
      {picked.body}
    </DirectoryForm>
  );
}

function ProjectPermissions({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<(Project & { granted: boolean })[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void cloudApi<{ projects: (Project & { granted: boolean })[] }>(url).then(
      (result) => setProjects(result.projects),
      (e) => setError(e.message),
    );
  }, [url]);
  return (
    <DirectoryForm
      title={'工地采购权限 · ' + name}
      onClose={onClose}
      onSubmit={async (values) => {
        await cloudApi(url, 'PUT', { project: values.project, granted: values.granted === 'yes' });
        onClose();
      }}
    >
      <label>
        工地
        <select name="project" required>
          <option value="">请选择工地</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.granted ? ' · 已授权' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        采购协同权限
        <select name="granted">
          <option value="yes">授予</option>
          <option value="no">撤销</option>
        </select>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </DirectoryForm>
  );
}

function OwnerEditor({
  member,
  action,
  projects,
  onClose,
  refresh,
}: {
  member?: OwnerMember;
  action: OwnerAction;
  projects: Project[];
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [invite, setInvite] = useState('');
  const options = action === 'grant' ? projects : (member?.projects.filter((p) => p.active) ?? []);
  const title =
    action === 'revoke'
      ? '撤销工地授权'
      : action === 'rebind'
        ? '重新绑定微信'
        : member
          ? '关联工地 / 发邀请'
          : '新增业主授权';
  return invite ? (
    <Modal title="一次性邀请" onClose={() => void refresh()} compactHeader animateClose>
      <div className="modal-body directory-editor">
        <label>
          邀请口令（24 小时有效）
          <input value={invite} readOnly onFocus={(e) => e.currentTarget.select()} />
        </label>
        <button
          type="button"
          onClick={(event) => {
            const button = event.currentTarget;
            void navigator.clipboard.writeText(invite).then(
              () => (button.textContent = '已复制'),
              () => (button.textContent = '可选中上方口令手动复制'),
            );
          }}
        >
          复制邀请口令
        </button>
      </div>
    </Modal>
  ) : (
    <DirectoryForm
      title={member ? title + ' · ' + member.name : title}
      onClose={onClose}
      onSubmit={async (values) => {
        const base = '/projects/' + encodeURIComponent(values.project) + '/owner-access/members';
        if (action === 'revoke') {
          await cloudApi(base + '/' + member!.id, 'DELETE', {});
          await refresh();
          return;
        }
        const result =
          action === 'rebind'
            ? await cloudApi<{ invite: string }>(
                base + '/' + member!.id + '/rebind',
                'POST',
                values.phone ? { phone: values.phone } : {},
              )
            : await cloudApi<{ invite: string }>(
                base,
                'POST',
                member
                  ? { memberId: member.id }
                  : { name: values.name, phone: values.phone, create: true },
              );
        setInvite(result.invite);
      }}
    >
      {!member && (
        <label>
          业主姓名
          <input name="name" required maxLength={60} />
        </label>
      )}
      {(!member || action === 'rebind') && (
        <label>
          {member ? '新手机号（可留空沿用）' : '业主手机号'}
          <input
            name="phone"
            type="tel"
            required={!member}
            pattern="1[3-9][0-9]{9}"
            maxLength={11}
            autoComplete="off"
          />
        </label>
      )}
      <label>
        工地
        <select name="project" required defaultValue={options.length === 1 ? options[0].id : ''}>
          <option value="">请选择工地</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || '已归档工地'}
              {p.enabled ? '' : ' · 业主服务关闭'}
            </option>
          ))}
        </select>
      </label>
      {action === 'rebind' && <p>保存后，该业主现有微信绑定和会话立即失效。</p>}
    </DirectoryForm>
  );
}

function DirectoryForm({
  title,
  onClose,
  submitLabel = '确认',
  onSubmit,
  children,
}: {
  title: string;
  onClose: () => void;
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError('');
    try {
      await onSubmit(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={() => !busy && onClose()} compactHeader animateClose>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-body directory-editor">
          {children}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
