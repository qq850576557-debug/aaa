import { useEffect, useRef, useState } from 'react';
import { Modal, Confirm } from './Modal';
import { cloudApi } from '../lib/cloud';
import { downloadBlob } from '../lib/export';
import type { LegacyCandidate, LegacyKind, LegacyLink } from '../lib/legacy-records';
type Row = LegacyCandidate & { hash: string; link?: LegacyLink; sourceChanged: boolean };
type Preview = {
  rows: Row[];
  token: string;
  expires: number;
  revision: number;
  projects: {
    id: string;
    name: string;
    existingPurchases: number;
    existingRecords: number;
    counts: Record<string, number>;
  }[];
  historyVersions: number;
};
const labels: Record<LegacyKind, string> = {
  purchase: '采购管理',
  record: '事项管理',
  reference: '历史资料',
  pending: '待确认分类',
};
const download = (v: unknown, name: string) =>
  downloadBlob(new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }), name);
export function LegacyMigrationPanel({ owner, onClose }: { owner: boolean; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState<string[]>([]),
    [choices, setChoices] = useState<
      Record<
        string,
        { kind: string; date?: string; owner?: string; existingId?: string; confirmNew?: boolean }
      >
    >({}),
    [batch, setBatch] = useState('record'),
    [filter, setFilter] = useState(''),
    [queue, setQueue] = useState(''),
    [backup, setBackup] = useState(false),
    [confirm, setConfirm] = useState(false),
    [result, setResult] = useState<{ backupId: string; results: unknown[] } | null>(null);
  const receipt = useRef<{ key: string; id: string } | null>(null);
  async function load() {
    setBusy(true);
    try {
      const p = await cloudApi<Preview>('/legacy-migration/preview');
      setPreview(p);
      setError('');
      setChecked([]);
      setChoices({});
      setBackup(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const rows = (preview?.rows || []).filter(
    (r) =>
      (!filter || r.projectId === filter) &&
      (!queue ||
        (queue === 'reference' &&
          !r.sourceChanged &&
          (r.link?.targetKind === 'reference' || (!r.link && r.kind === 'reference'))) ||
        queue === (r.sourceChanged ? 'pending' : r.link ? 'handled' : r.kind)),
  );
  const selection = (r: Row) => choices[r.key] || { kind: r.kind === 'pending' ? '' : r.kind };
  function update(r: Row, patch: Partial<ReturnType<typeof selection>>) {
    setChoices((old) => ({ ...old, [r.key]: { ...selection(r), ...patch } }));
  }
  async function run() {
    if (!preview || busy) return;
    setConfirm(false);
    setBusy(true);
    try {
      const selections = preview.rows
        .filter((r) => checked.includes(r.key))
        .map((r) => ({ key: r.key, hash: r.hash, ...selection(r) }));
      if (selections.some((x) => !x.kind)) throw Error('请为所有选中记录确认类别');
      const body = {
        token: preview.token,
        expires: preview.expires,
        confirmed: true,
        backupConfirmed: true,
        selections,
      };
      const key = JSON.stringify(body);
      if (receipt.current?.key !== key) receipt.current = { key, id: crypto.randomUUID() };
      const saved = await cloudApi<{ backupId: string; results: unknown[] }>(
        '/legacy-migration/commit',
        'POST',
        { ...body, requestId: receipt.current.id },
      );
      setResult(saved);
      window.dispatchEvent(new Event('chunmo-records-changed'));
      await load();
    } catch (e) {
      setError(String(e) + '；原数据未删除，请核对预览或使用相同操作重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title="历史数据分类与兼容"
        subtitle="先只读预览，再由负责人备份并确认；原记录与真实历史均保留。"
        wide
        blocking
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="modal-body legacy-panel">
          <div className="toolbar">
            <button disabled={busy} onClick={() => void load()}>
              重新预览
            </button>
            {owner && (
              <button
                disabled={busy}
                onClick={() =>
                  void cloudApi('/legacy-migration/backup')
                    .then((v) => {
                      download(v, '春茉-历史迁移前原始备份.json');
                      setBackup(true);
                    })
                    .catch((e) => setError(String(e)))
                }
              >
                下载迁移前原始备份
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          {result && (
            <p role="status">
              已核对 {result.results.length} 条来源。
              <button
                onClick={() =>
                  void cloudApi('/legacy-migration/backup/' + result.backupId).then((v) =>
                    download(v, '春茉-已完成迁移的前置备份.json'),
                  )
                }
              >
                下载本批次服务端备份
              </button>
            </p>
          )}
          {preview && (
            <>
              <p>
                本次预览来自真实工作室数据，工作空间版本 {preview.revision}；已有{' '}
                {preview.historyVersions} 个历史版本只保留，不复活已删除的历史快照。
              </p>
              <div className="legacy-project-summary">
                {preview.projects.map((p) => (
                  <div key={p.id}>
                    <strong>{p.name}</strong>
                    <small>
                      现有采购 {p.existingPurchases} · 看板 {p.existingRecords} · 可归采购{' '}
                      {p.counts.purchase} · 可归事项 {p.counts.record} · 资料 {p.counts.reference} ·
                      待确认 {p.counts.pending}
                    </small>
                  </div>
                ))}
              </div>
              <div className="toolbar">
                <label>
                  项目
                  <select
                    aria-label="历史分类项目"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setChecked([]);
                    }}
                  >
                    <option value="">全部项目</option>
                    {preview.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <select
                  aria-label="历史分类状态"
                  value={queue}
                  onChange={(e) => {
                    setQueue(e.target.value);
                    setChecked([]);
                  }}
                >
                  <option value="">全部分类</option>
                  <option value="pending">待确认分类</option>
                  <option value="purchase">采购管理</option>
                  <option value="record">事项管理</option>
                  <option value="reference">历史资料</option>
                  <option value="handled">已处理</option>
                </select>
                {owner && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => setChecked(rows.filter((r) => !r.link).map((r) => r.key))}
                    >
                      选择当前项目未处理记录
                    </button>
                    <select
                      aria-label="批量确认归属"
                      value={batch}
                      onChange={(e) => setBatch(e.target.value)}
                    >
                      {['record', 'purchase', 'reference'].map((v) => (
                        <option key={v} value={v}>
                          {labels[v as LegacyKind]}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={busy || !checked.length}
                      onClick={() =>
                        setChoices((old) => ({
                          ...old,
                          ...Object.fromEntries(
                            checked.map((key) => [key, { ...old[key], kind: batch }]),
                          ),
                        }))
                      }
                    >
                      应用到选中记录
                    </button>
                  </>
                )}
              </div>
              <div className="legacy-source-list">
                {rows.map((r) => (
                  <article key={r.key} className="legacy-source">
                    <header>
                      {owner && !r.link && (
                        <input
                          aria-label={'选择历史记录' + r.title}
                          type="checkbox"
                          disabled={busy}
                          checked={checked.includes(r.key)}
                          onChange={(e) =>
                            setChecked((old) =>
                              e.target.checked
                                ? [...old, r.key]
                                : old.filter((key) => key !== r.key),
                            )
                          }
                        />
                      )}
                      <strong>{r.title}</strong>
                      <span className="status-tag">
                        {r.sourceChanged
                          ? '来源变更，待人工核对'
                          : r.link
                            ? '已处理 · ' + labels[r.link.targetKind as LegacyKind]
                            : labels[r.kind]}
                      </span>
                    </header>
                    <small>
                      {preview.projects.find((p) => p.id === r.projectId)?.name} ·{' '}
                      {r.date || '原日期未记录'} · {r.done ? '原状态：已完成' : '原状态：未完成'} ·{' '}
                      {r.owner || '原负责人未记录'}
                    </small>
                    <p>{r.reason}</p>
                    <details>
                      <summary>核对完整原文与来源</summary>
                      <pre>
                        {JSON.stringify(
                          { 来源: r.key, 原始记录: r.original, 映射: r.link },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                    {!!r.matches.length && (
                      <details>
                        <summary>核对可能重复的现有记录</summary>
                        <pre>{JSON.stringify(r.matches, null, 2)}</pre>
                      </details>
                    )}
                    {owner && !r.link && (
                      <div className="legacy-row-controls">
                        <select
                          aria-label={'确认归属' + r.title}
                          value={selection(r).kind}
                          disabled={busy}
                          onChange={(e) =>
                            update(r, {
                              kind: e.target.value,
                              existingId: undefined,
                              confirmNew: false,
                            })
                          }
                        >
                          <option value="">待确认分类</option>
                          {['record', 'purchase', 'reference'].map((v) => (
                            <option key={v} value={v}>
                              {labels[v as LegacyKind]}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={'迁移日期' + r.title}
                          type="date"
                          disabled={busy}
                          value={selection(r).date ?? r.date}
                          onChange={(e) => update(r, { date: e.target.value })}
                        />
                        {r.owner.length > 100 && (
                          <input
                            aria-label={'兼容负责人' + r.title}
                            placeholder="明确填写新记录负责人，原文保留"
                            value={selection(r).owner ?? ''}
                            onChange={(e) => update(r, { owner: e.target.value })}
                          />
                        )}
                        {(!!r.matches.length || r.sourceDuplicates) && (
                          <select
                            aria-label={'重复记录处理' + r.title}
                            value={
                              selection(r).existingId ?? (selection(r).confirmNew ? 'new' : '')
                            }
                            onChange={(e) =>
                              update(r, {
                                existingId:
                                  e.target.value && e.target.value !== 'new'
                                    ? e.target.value
                                    : undefined,
                                confirmNew: e.target.value === 'new',
                              })
                            }
                          >
                            <option value="">自动沿用唯一完全匹配项；否则待确认</option>
                            {r.matches
                              .filter((m) => m.kind === selection(r).kind)
                              .map((m) => (
                                <option key={m.kind + m.id} value={m.id} disabled={m.deleted}>
                                  {m.deleted ? '已删除，不能沿用' : '沿用现有'} {labels[m.kind]} ·{' '}
                                  {m.date || '无日期'} · {m.status} · {m.id}
                                </option>
                              ))}
                            <option value="new">确认是不同事项，明确新建</option>
                          </select>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
          {owner && (
            <button
              className="primary"
              disabled={busy || !backup || !checked.length}
              onClick={() => setConfirm(true)}
            >
              {busy ? '正在处理' : '确认迁移选中记录'}
            </button>
          )}
        </footer>
      </Modal>
      {confirm && (
        <Confirm
          title="确认已核对备份与分类？"
          message={`本次处理 ${checked.length} 条来源：${preview?.rows
            .filter((r) => checked.includes(r.key))
            .slice(0, 20)
            .map((r) => r.title)
            .join(
              '、',
            )}。不会删除原记录，不覆盖现有目标；任何失败会整批回滚。生产环境请在取得创始人批准并核实可恢复备份后执行。`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void run()}
        />
      )}
    </>
  );
}
