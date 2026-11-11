import { mobileRequested } from './mode';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Camera, ClipboardList, ShoppingCart, Home, Plus } from 'lucide-react';
import type { Data, Purchase } from '../lib/model';
import { plus, purchaseStatuses } from '../lib/model';
import type { WorkRecord } from '../lib/records';
import { cloudApi, type CloudUser } from '../lib/cloud';
import { categorizedAgenda, type AgendaItem } from '../lib/agenda';
import { MentionInbox } from '../components/MentionInbox';
import { Avatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { SaveFeedback } from '../components/SaveFeedback';
import './mobile.css';
import '../components/purchase-status.css';
const loadPhotos = () => import('./QuickPhoto').then((m) => ({ default: m.QuickPhoto }));
const Photos = lazy(loadPhotos);
export function MobileAssistant({
  data,
  records,
  user,
  now,
  status,
  error,
  loading,
  onRetry,
  onNew,
  onOpen,
  onToggle,
  onDelete,
  onPurchaseStatus,
  initialProject = '',
}: {
  initialProject?: string;
  data: Data;
  records: WorkRecord[];
  user: CloudUser | null;
  now: string;
  status: string;
  error: string;
  loading: boolean;
  onRetry: () => void;
  onNew: (date: string, projectId: string, category?: 'record' | 'purchase') => void;
  onOpen: (item: AgendaItem) => void;
  onToggle: (item: AgendaItem) => void;
  onDelete: (item: AgendaItem) => void;
  onPurchaseStatus: (p: Purchase, status: Purchase['status']) => void;
}) {
  const [tab, setTab] = useState<'home' | 'records' | 'purchases' | 'photo'>('home'),
    [project, setProject] = useState(() =>
      data.projects.some((p) => p.id === initialProject) ? initialProject : '',
    ),
    [onlyOpen, setOnlyOpen] = useState(false),
    [profile, setProfile] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [install, setInstall] = useState<any>(null),
    [update, setUpdate] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => void loadPhotos().catch(() => {}), 400);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    document.title = '春茉后台管理（手机版）';
    const prompt = (e: Event) => {
      e.preventDefault();
      setInstall(e);
    };
    window.addEventListener('beforeinstallprompt', prompt);
    let active = true;
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.ready.then((reg) => {
        if (!reg) return;
        if (reg.waiting) setUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          w?.addEventListener('statechange', () => {
            if (active && w.state === 'installed' && navigator.serviceWorker.controller)
              setUpdate(w);
          });
        });
      });
    return () => {
      active = false;
      document.title = mobileRequested()
        ? '春茉后台管理（手机版）'
        : '春茉空间设计｜装修项目管理系统';
      window.removeEventListener('beforeinstallprompt', prompt);
    };
  }, []);
  const items = data.projects
    .flatMap((p) => categorizedAgenda(data, records, p.id, now).items)
    .filter((i) => i.kind === 'record' || i.kind === 'purchase');
  const visible = items
    .filter(
      (i) =>
        (!project || i.projectId === project) &&
        ((tab === 'records' && i.kind === 'record') ||
          (tab === 'purchases' && i.kind === 'purchase')) &&
        (!onlyOpen || !i.done),
    )
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    );
  const handleOpen = (item: AgendaItem) => {
    setProject(item.projectId);
    onOpen(item);
  };
  const name = (id: string) => data.projects.find((p) => p.id === id)?.name || '历史工地';
  const row = (i: AgendaItem) => (
    <article
      key={i.kind + ':' + i.id}
      className={`mobile-work-row ${i.done ? 'done' : ''}`}
      data-purchase-status={i.kind === 'purchase' ? i.status : undefined}
    >
      <button className="mobile-work-main" onClick={() => handleOpen(i)}>
        <strong>{i.title}</strong>
        <span>{name(i.projectId)}</span>
        <span>
          {i.date || '未设日期'} · {i.kind === 'purchase' ? '采购' : '事项'} · {i.status}
        </span>
        {i.value.owner && <span>负责人：{i.value.owner}</span>}
      </button>
      <div className="mobile-actions">
        {i.kind === 'purchase' ? (
          <select
            disabled={i.done && !user?.owner}
            aria-label={`${i.title}采购状态`}
            value={i.value.status}
            onChange={(e) =>
              onPurchaseStatus(i.value as Purchase, e.target.value as Purchase['status'])
            }
          >
            {purchaseStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <button disabled={i.status === '已取消'} onClick={() => onToggle(i)}>
            {i.done ? '恢复跟进' : '完成'}
          </button>
        )}
        <button onClick={() => handleOpen(i)}>编辑</button>
        <button className="danger" onClick={() => onDelete(i)}>
          删除
        </button>
      </div>
    </article>
  );
  return (
    <div className="mobile-assistant">
      <header className="assistant-header" hidden={cameraActive}>
        <button
          className="assistant-brand"
          onClick={() => setTab('home')}
          aria-label="春茉后台管理（手机版）首页"
        >
          <img src="/brand/source/chunmo-original.jpg" alt="春茉原始Logo" />
          <strong>春茉后台管理（手机版）</strong>
        </button>
        {user && (
          <>
            <button aria-label="我的账号" onClick={() => setProfile(true)}>
              <Avatar account={user} />
            </button>
            <MentionInbox key={user.id} />
          </>
        )}
      </header>
      <div className="save-state sr-only" role="status">
        {status}
      </div>
      <main className="assistant-content">
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button onClick={onRetry}>重试</button>
          </div>
        )}
        {loading && <p role="status">正在读取…</p>}
        {update && (
          <button
            onClick={() => {
              if (confirm('请确认当前编辑已保存。更新并重新打开？')) {
                update.postMessage({ type: 'ACTIVATE' });
                navigator.serviceWorker.addEventListener(
                  'controllerchange',
                  () => location.reload(),
                  { once: true },
                );
              }
            }}
          >
            新版本已就绪，点击更新
          </button>
        )}
        {install && (
          <button onClick={() => void install.prompt()}>安装春茉后台管理（手机版）</button>
        )}
        <SaveFeedback compact cloud={!!user} status={status} onRetry={onRetry} />
        {tab === 'home' ? (
          <>
            <div className="assistant-day-nav">
              <button
                onClick={() =>
                  document
                    .getElementById('assistant-today')
                    ?.scrollIntoView({ behavior: 'instant' })
                }
              >
                今日提醒
              </button>
              <button
                onClick={() =>
                  document
                    .getElementById('assistant-tomorrow')
                    ?.scrollIntoView({ behavior: 'instant' })
                }
              >
                明日提醒
              </button>
            </div>
            {[now, plus(now, 1)].map((date, index) => (
              <section
                id={index ? 'assistant-tomorrow' : 'assistant-today'}
                className="assistant-day"
                key={date}
              >
                <header>
                  <h2>{index ? '明日提醒' : '今日提醒'}</h2>
                  <time>{date}</time>
                  <button onClick={() => onNew(date, project)}>＋新增</button>
                </header>
                {items.filter((i) => !i.done && i.date === date).map(row)}
                {!items.some((i) => !i.done && i.date === date) && <p>暂无待处理记录</p>}
              </section>
            ))}
            <div className="assistant-entry-grid">
              <button onClick={() => setTab('records')}>事项管理</button>
              <button onClick={() => setTab('purchases')}>采购管理</button>
            </div>
            <details className="pwa-help">
              <summary>添加到手机桌面</summary>
              <p>
                iPhone Safari：分享 → 添加到主屏幕。安卓 Chrome：菜单 → 安装应用。需通过HTTPS打开。
              </p>
              <p>
                iPhone已有图标由系统缓存管理，打开网页不一定刷新。需要重新添加时，先核对本机照片已上传、云端可打开，并保留原图及待同步内容的独立备份。
              </p>
              <p>
                保留原应用和网站数据，从Safari重新添加到主屏幕；核对完成前不要删除原PWA、清除Safari网站数据或重置本地存储。
              </p>
            </details>
          </>
        ) : tab === 'photo' ? (
          user ? (
            <Suspense fallback={<p>正在打开拍照…</p>}>
              <Photos
                user={user}
                onSessionChange={setCameraActive}
                onReturn={() => {
                  setCameraActive(false);
                  setTab('home');
                }}
              />
            </Suspense>
          ) : (
            <p>请先登录云端账号</p>
          )
        ) : (
          <section>
            <header className="assistant-list-heading">
              <h2>{tab === 'records' ? '事项管理' : '采购管理'}</h2>
            </header>
            <div className="assistant-filters">
              <select
                aria-label="手机工地筛选"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">全部工地</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={onlyOpen}
                  onChange={(e) => setOnlyOpen(e.target.checked)}
                />
                待完成
              </label>
            </div>
            {visible.map(row)}
            {!visible.length && <p>暂无记录</p>}
          </section>
        )}
      </main>
      {(tab === 'records' || tab === 'purchases') && (
        <button
          className="assistant-fab"
          aria-label={tab === 'records' ? '新增事项' : '新增采购'}
          title={tab === 'records' ? '新增事项' : '新增采购'}
          onClick={() => onNew(now, project, tab === 'records' ? 'record' : 'purchase')}
        >
          <Plus size={26} aria-hidden="true" />
        </button>
      )}
      <nav hidden={cameraActive} className="assistant-nav" aria-label="手机主要入口">
        <button
          onClick={() => setTab('home')}
          aria-label="首页"
          aria-current={tab === 'home' ? 'page' : undefined}
        >
          <Home size={20} />
          <span>提醒</span>
        </button>
        <button
          onClick={() => setTab('records')}
          aria-current={tab === 'records' ? 'page' : undefined}
        >
          <ClipboardList size={20} />
          <span>事项</span>
        </button>
        <button
          onClick={() => setTab('purchases')}
          aria-current={tab === 'purchases' ? 'page' : undefined}
        >
          <ShoppingCart size={20} />
          <span>采购</span>
        </button>
        <button
          className="assistant-camera"
          onClick={() => {
            setTab('photo');
          }}
          aria-current={tab === 'photo' ? 'page' : undefined}
        >
          <Camera size={22} />
          <span>拍照</span>
        </button>
      </nav>
      {profile && user && (
        <Modal title="当前账号" onClose={() => setProfile(false)}>
          <div className="modal-body">
            <p>{user.displayName || user.login}</p>
            <button
              onClick={() => {
                if (confirm('本机待同步内容会保留。确认退出登录？'))
                  void cloudApi('/auth/logout', 'POST', {})
                    .then(() =>
                      window.dispatchEvent(
                        new CustomEvent('chunmo-auth-expired', {
                          detail: { clearWorkspace: true },
                        }),
                      ),
                    )
                    .catch(() => alert('退出失败，请联网后重试'));
              }}
            >
              退出登录
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
