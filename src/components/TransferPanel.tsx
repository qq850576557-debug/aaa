import { useEffect, useState } from 'react';
import { cloudApi } from '../lib/cloud';
import { type Data } from '../lib/model';
import { type MaterialState } from '../lib/materials';
import { type Transfer } from '../lib/transfers';
import { transferSuggestions } from '../lib/material-recommendations';
import { Modal } from './Modal';
export function TransferPanel({
  data,
  state,
  project,
  owner,
  onSaved,
}: {
  data: Data;
  state: MaterialState;
  project: string;
  owner: boolean;
  onSaved: () => Promise<void>;
}) {
  const [transfers, setTransfers] = useState<Transfer[]>([]),
    [accounts, setAccounts] = useState<{ id: string; displayName: string; login: string }[]>([]),
    [edit, setEdit] = useState<{ t?: Transfer; action: string; requestId: string } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [log, setLog] = useState<any[] | null>(null);
  const load = async () => {
    const [r, d] = await Promise.all([
      cloudApi<{ transfers: Transfer[] }>('/materials/transfers'),
      cloudApi<{ accounts: typeof accounts }>('/directory'),
    ]);
    setTransfers(r.transfers);
    setAccounts(d.accounts);
  };
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [project, state.events]);
  const name = (id: string) => data.projects.find((p) => p.id === id)?.name || '历史工地（暂缺）',
    mat = (id: string) => state.materials.find((m) => m.id === id),
    labels: Record<string, string> = {
      create: '申请调拨',
      approve: '批准待发出',
      dispatch: '确认发出',
      receive: '确认接收',
      return: '在途退回',
      loss: '确认在途损耗',
      cancel: '取消调拨',
    };
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!edit) return;
    const f = new FormData(e.currentTarget),
      reason = String(f.get('reason'));
    setBusy(true);
    setError('');
    try {
      await cloudApi(
        '/materials/transfers' + (edit.t ? '/' + edit.t.id : ''),
        'POST',
        edit.t
          ? {
              requestId: edit.requestId,
              version: edit.t.version,
              action: edit.action,
              quantity: String(f.get('quantity') || '0'),
              reason,
            }
          : {
              requestId: edit.requestId,
              projectId: project,
              targetProjectId: String(f.get('target')),
              materialId: String(f.get('material')),
              quantity: String(f.get('quantity')),
              handlerId: String(f.get('handler')),
              transportCost: String(f.get('cost') || '0'),
              reason,
            },
      );
      await onSaved();
      await load();
      setEdit(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  const begin = (action: string, t?: Transfer) => {
    setError('');
    setEdit({ action, t, requestId: crypto.randomUUID() });
  };
  return (
    <section aria-label="工地调拨流程">
      <h3>{name(project)} · 调拨与在途材料</h3>
      <p>
        申请不增加库存；发出扣来源，接收才入目标。部分接收的余量保留在途，可退回或由负责人确认损耗。
      </p>
      <button onClick={() => begin('create')}>申请跨工地调拨</button>
      {error && !edit && <p role="alert">{error}</p>}
      {transfers
        .filter((t) => t.projectId === project || t.targetProjectId === project)
        .map((t) => (
          <article className="transfer-card" key={t.id}>
            <strong>
              {name(t.projectId)} → {name(t.targetProjectId)} · {t.status}
            </strong>
            <p>
              单号 {t.id} · {mat(t.materialId)?.name} / {mat(t.materialId)?.specification} ·{' '}
              {t.quantity}
              {mat(t.materialId)?.unit}
            </p>
            <p>
              发出 {t.sent} / 接收 {t.received} / 退回 {t.returned} / 损耗 {t.lost} · 在途{' '}
              {(Number(t.sent) - Number(t.received) - Number(t.returned) - Number(t.lost)).toFixed(
                3,
              )}
            </p>
            <p>
              申请 {t.createdName} · 经手 {t.handlerName} · 接收 {t.receiverName || '待接收'} ·
              运输成本 ¥{t.transportCost}
            </p>
            <p>
              {t.reason} · 更新{' '}
              {new Date(t.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            </p>
            <div className="toolbar">
              {(t.status === '申请'
                ? ['approve', 'cancel']
                : t.status === '待发出'
                  ? ['dispatch', 'cancel']
                  : ['交接中', '部分接收'].includes(t.status)
                    ? ['receive', 'return', ...(owner ? ['loss'] : [])]
                    : []
              ).map((a) => (
                <button key={a} onClick={() => begin(a, t)}>
                  {labels[a]}
                </button>
              ))}
              <button
                onClick={() =>
                  void cloudApi<{ events: any[] }>('/materials/history/' + t.id)
                    .then((r) => setLog(r.events))
                    .catch((e) => setError(String(e)))
                }
              >
                调拨历史
              </button>
            </div>
          </article>
        ))}
      <h3>可核查的余料建议</h3>
      {transferSuggestions(state, data, project).map((r, i) => (
        <article className="transfer-card" key={i}>
          <strong>
            {mat(r.materialId)?.name} → {name(r.context.projectId)}
          </strong>
          <p>
            来源后续预留 {r.reserve.toFixed(3)}；可调 {r.available.toFixed(3)}；目标缺口{' '}
            {r.need.toFixed(3)}；建议上限 {r.quantity.toFixed(3)} {mat(r.materialId)?.unit}
          </p>
          <p>
            目标阶段 {r.context.phase} · 计划进场 {r.start || '未关联，需核实'} · 运输估算{' '}
            {r.transportCost === null ? '尚未登记，请核实' : '¥' + r.transportCost.toFixed(2)}
          </p>
          <p>{r.checks.join('；')}。</p>
        </article>
      ))}
      {edit && (
        <Modal title={labels[edit.action]} onClose={() => !busy && setEdit(null)}>
          <form onSubmit={save}>
            <div className="modal-body form-grid">
              <p className="span2">
                来源 {name(edit.t?.projectId ?? project)}{' '}
                {edit.t && '→ ' + name(edit.t.targetProjectId)}；确认后生成真实操作记录。
              </p>
              {!edit.t && (
                <>
                  <label>
                    调入工地
                    <select name="target" required aria-label="调入工地">
                      {data.projects
                        .filter((p) => p.id !== project)
                        .map((p) => (
                          <option value={p.id} key={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    调拨材料
                    <select name="material" required aria-label="调拨材料">
                      {state.materials
                        .filter((m) => m.active)
                        .map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name} · {m.specification} · {m.unit}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    经手账号
                    <select name="handler" required aria-label="经手账号">
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.displayName || a.login}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    运输成本
                    <input
                      name="cost"
                      aria-label="运输成本"
                      defaultValue="0"
                      inputMode="decimal"
                      required
                    />
                  </label>
                </>
              )}
              {(!edit.t || ['receive', 'return', 'loss'].includes(edit.action)) && (
                <label>
                  本次数量
                  <input
                    name="quantity"
                    aria-label="调拨本次数量"
                    defaultValue={
                      edit.t
                        ? (
                            Number(edit.t.sent) -
                            Number(edit.t.received) -
                            Number(edit.t.returned) -
                            Number(edit.t.lost)
                          ).toFixed(3)
                        : '0'
                    }
                    required
                    inputMode="decimal"
                  />
                </label>
              )}
              <label className="span2">
                原因／差异说明
                <textarea name="reason" aria-label="调拨原因" required maxLength={2000} />
              </label>
              {error && (
                <p role="alert" className="span2">
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <button type="button" disabled={busy} onClick={() => setEdit(null)}>
                返回
              </button>
              <button className="primary" disabled={busy}>
                {labels[edit.action].startsWith('确认')
                  ? labels[edit.action]
                  : '确认' + labels[edit.action]}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {log && (
        <Modal title="调拨操作历史" onClose={() => setLog(null)}>
          <div className="modal-body">
            {log.map((x, i) => (
              <p key={i}>
                {x.actorName} ·{' '}
                {new Date(x.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ·{' '}
                {x.after?.status} · {x.after?.reason}
              </p>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
