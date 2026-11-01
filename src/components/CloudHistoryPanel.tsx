import { useEffect, useRef, useState } from 'react';
import { Modal, Confirm, type Anchor } from './Modal';
import { cloudApi } from '../lib/cloud';
import { savedFeedback } from './SaveFeedback';
import { downloadBlob } from '../lib/export';
type Node = {
  kind: 'workspace' | 'record' | 'record-log';
  id: string;
  recordId?: string;
  version: number | null;
  currentVersion?: number;
  at: string;
  actor: string;
  name: string;
  status: string;
  summary: string;
};
function VersionContent({ value }: { value: unknown }) {
  const v = value as Record<string, any>;
  if (!v || typeof v !== 'object') return null;
  const labels: Record<string, string> = {
    project_name: '所属项目',
    title: '事项内容',
    node_date: '计划日期',
    status: '状态',
    owner: '负责人',
    notes: '备注',
    follow_up: '跟进',
  };
  if (v.title)
    return (
      <dl className="cloud-version-fields">
        {Object.entries(labels).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{String(v[key] || '未记录')}</dd>
          </div>
        ))}
      </dl>
    );
  if (v.kind && v.data)
    return (
      <div className="cloud-version-scope">
        <p>
          {v.kind === 'project' ? '此版本只包含所选项目范围' : '此版本为全局人员与工作空间范围'}
        </p>
        {Object.entries({
          projects: '项目资料',
          trades: '施工工种',
          tasks: '施工任务',
          purchases: '采购事项',
          notes: '旧版事项与备忘',
          people: '人员档案',
        }).map(([key, label]) =>
          Array.isArray(v.data[key]) ? (
            <section key={key}>
              <h4>
                {label} · {v.data[key].length}
              </h4>
              {v.data[key].map((item: any) => (
                <p key={item.id}>
                  <strong>{item.name || item.title || item.id}</strong>{' '}
                  <span>
                    {item.status || ''} {item.start || item.date || item.due || ''}
                    {item.end ? ' — ' + item.end : ''}
                  </span>
                </p>
              ))}
            </section>
          ) : null,
        )}
      </div>
    );
  return <p>此旧版只保留操作人、时间与字段变更摘要，没有完整内容快照，不能执行恢复。</p>;
}
export function CloudHistoryPanel({
  anchor,
  owner,
  canRestore,
  onClose,
  onRestored,
}: {
  anchor: Anchor;
  owner: boolean;
  canRestore: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [list, setList] = useState<{ revision: number; nodes: Node[] } | null>(null),
    [detail, setDetail] = useState<{ node: Node; content: unknown } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<Node | null>(null),
    [backupId, setBackupId] = useState('');
  const [limit, setLimit] = useState(50);
  const currentNode = (n: Node) =>
    n.kind === 'record'
      ? n.version === n.currentVersion
      : n.version !== null && Number(n.version) === list?.revision;
  const receipt = useRef<{ key: string; id: string } | null>(null);
  async function load() {
    setBusy(true);
    try {
      setList(await cloudApi('/history/versions'));
      setError('');
      setDetail(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function restore() {
    if (!target || !list || busy) return;
    if (document.querySelector('dialog form')) {
      setError('请先保存并关闭其他编辑表单，未执行恢复。');
      setTarget(null);
      return;
    }
    const body = {
      kind: target.kind,
      id: target.id,
      revision: list.revision,
      ...(target.currentVersion ? { currentVersion: target.currentVersion } : {}),
    };
    const key = JSON.stringify(body);
    if (receipt.current?.key !== key) receipt.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    try {
      const result = await cloudApi<{ backupId: string }>('/history/versions/restore', 'POST', {
        ...body,
        requestId: receipt.current.id,
      });
      setBackupId(result.backupId);
      setTarget(null);
      savedFeedback('restore-' + result.backupId, 'restore');
      window.dispatchEvent(new Event('chunmo-records-changed'));
      await load();
      onRestored();
    } catch (e) {
      setError(String(e) + '；未强行覆盖，请重新读取核对，草稿保留。');
      setTarget(null);
    } finally {
      setBusy(false);
    }
  }
  const groups = (list?.nodes ?? []).slice(0, limit).reduce<Record<string, Node[]>>((groups, n) => {
    const date = new Date(n.at).toLocaleDateString('zh-CN');
    (groups[date] ??= []).push(n);
    return groups;
  }, {});
  return (
    <>
      <Modal
        title="云端历史版本"
        subtitle="最近15天 · 服务端已确认的修改"
        anchor={anchor}
        className={`cloud-history-panel ${detail ? 'show-detail' : ''}`}
        onClose={() => !busy && onClose()}
      >
        <div className="modal-body cloud-history-body">
          <div className="toolbar">
            <button disabled={busy} onClick={() => void load()}>
              检查更新
            </button>
            <small>工作空间版本 {list?.revision ?? '读取中'}</small>
          </div>
          <p className="muted">
            工作空间与事项独立编号。旧版缺失的编号或快照不补造；恢复仅限负责人，先备份再校验。
          </p>
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          {backupId && owner && (
            <button
              onClick={() =>
                void cloudApi('/history/restore-backups/' + backupId)
                  .then((v) =>
                    downloadBlob(
                      new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }),
                      '春茉-恢复前自动备份.json',
                    ),
                  )
                  .catch((e) => setError(String(e)))
              }
            >
              下载恢复前备份
            </button>
          )}
          {detail ? (
            <section className="cloud-version-detail">
              <button onClick={() => setDetail(null)}>返回版本列表</button>
              <h3>{detail.node.name}</h3>
              <p>
                {currentNode(detail.node) ? '当前版本' : '历史版本'} · {detail.node.actor} ·{' '}
                {new Date(detail.node.at).toLocaleString('zh-CN')}
              </p>
              <VersionContent value={detail.content} />
              <details>
                <summary>查看原始版本数据</summary>
                <pre>{JSON.stringify(detail.content, null, 2)}</pre>
              </details>
              <button
                disabled={
                  !canRestore ||
                  !owner ||
                  busy ||
                  currentNode(detail.node) ||
                  detail.node.kind === 'record-log'
                }
                onClick={() => setTarget(detail.node)}
              >
                恢复此版本
              </button>
            </section>
          ) : (
            Object.entries(groups).map(([date, nodes]) => (
              <section key={date} className="cloud-history-day">
                <h3>{date}</h3>
                {nodes!.map((n) => (
                  <article key={n.kind + n.id}>
                    <button
                      className="cloud-version-open"
                      onClick={() =>
                        void cloudApi<{ content: unknown }>(
                          `/history/versions/${n.kind}/${encodeURIComponent(n.id)}`,
                        )
                          .then((v) => {
                            setDetail({ node: n, content: v.content });
                            setError('');
                          })
                          .catch((e) => setError(String(e)))
                      }
                    >
                      <time>{new Date(n.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                      <strong>{n.actor}</strong>
                      <span>
                        {n.kind === 'workspace' ? '工作空间' : '事项'} ·{' '}
                        {n.version === null ? '旧版编号未记录' : 'V' + n.version}
                      </span>
                      <span>
                        {n.name} · {n.summary}
                      </span>
                      <small>
                        {n.status} · {currentNode(n) ? '当前版本' : '已确认'}
                      </small>
                    </button>
                  </article>
                ))}
              </section>
            ))
          )}
          {!detail && list && list.nodes.length > limit && (
            <button onClick={() => setLimit((v) => v + 50)}>
              显示更多版本（剩余 {list.nodes.length - limit}）
            </button>
          )}
          {list && !list.nodes.length && <p>最近15天暂无可追溯版本。</p>}
        </div>
        <footer className="modal-foot">
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </footer>
      </Modal>
      {target && (
        <Confirm
          busy={busy}
          title="恢复此历史版本？"
          message={`将恢复「${target.name}」的所选版本。服务器会自动备份当前完整工作空间和事项，再检查最新版本；恢复本身生成新版本，原历史保留。此操作会替换所选项目范围或所选事项，请确认已核对之后的修改。`}
          onCancel={() => !busy && setTarget(null)}
          onConfirm={() => void restore()}
        />
      )}
    </>
  );
}
