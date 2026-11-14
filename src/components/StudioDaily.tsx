import { useEffect, useState, useRef } from 'react';
import { Modal } from './Modal';
import { BriefPanel } from './BriefPanel';
import { ruleActive, duty, studioWeek, type StudioSettings } from '../lib/studio-daily';
import { plus } from '../lib/model';
import './studio-daily.css';
type Result = {
  version: number;
  value: StudioSettings;
  users: { id: string; name: string; active?: boolean }[];
  owner: boolean;
  day: string;
};
export function StudioDaily({ cloud }: { cloud: boolean }) {
  const [state, setState] = useState<Result | null>(null),
    [error, setError] = useState(''),
    [draft, setDraft] = useState<StudioSettings | null>(null),
    [mode, setMode] = useState(''),
    [busy, setBusy] = useState(false),
    [week, setWeek] = useState(false);
  const pending = useRef<any>(null);
  async function load() {
    try {
      const r = await fetch('/api/studio-daily');
      if (!r.ok) throw Error('工作室日常读取失败，请重试');
      setState(await r.json());
      setError('');
    } catch (e) {
      setError(String((e as Error).message));
    }
  }
  useEffect(() => {
    if (cloud) void load();
  }, [cloud]);
  const names = (ids: string[]) =>
    ids.map((id) => state?.users.find((u) => u.id === id)?.name || '已停用账号').join('、') ||
    '暂无安排';
  function edit(m: string) {
    if (draft) {
      setMode(m);
      return;
    }
    pending.current = null;
    setDraft(structuredClone(state!.value));
    setMode(m);
    setError('');
  }
  function change(value: StudioSettings) {
    pending.current = null;
    setDraft(value);
  }
  async function save() {
    if (!draft || !state || busy) return;
    setBusy(true);
    try {
      const s = await (await fetch('/api/auth/session')).json();
      const body =
        pending.current ||
        (pending.current = {
          version: state.version,
          value: draft,
          requestId: crypto.randomUUID(),
        });
      const r = await fetch('/api/studio-daily', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json();
        throw Error(e.error || '保存失败，草稿保留');
      }
      const ack = await r.json();
      if (!Number.isInteger(ack.version)) throw Error('云端未确认，草稿保留');
      pending.current = null;
      setDraft(null);
      setMode('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const people = (selected: string[], onChange: (v: string[]) => void) => (
    <div className="studio-people">
      {state?.users.map((u) => (
        <label key={u.id}>
          <input
            type="checkbox"
            checked={selected.includes(u.id)} disabled={u.active === false && !selected.includes(u.id)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, u.id] : selected.filter((id) => id !== u.id),
              )
            }
          />
          {u.name}{u.active === false ? '（停用）' : ''}
        </label>
      ))}
    </div>
  );
  if (!cloud) return <section className="panel">工作室日常需登录云端账号后使用。</section>;
  return (
    <section className="studio-daily">
      <h2>工作室日常</h2>
      {error && !mode && (
        <p role="alert">
          {error}
          <button onClick={() => void load()}>重试</button>
        </p>
      )}
      <div className="studio-columns">
        <BriefPanel
          title="每日必做"
          testId="studio-rules"
          items={(state?.value.rules || [])
            .filter((r) => ruleActive(r, state!.day))
            .map((r) => (
              <article className="studio-rule" key={r.id}>
                <strong>{r.text}</strong>
                {(r.from || r.to) && (
                  <small>
                    {r.from || '不限'} — {r.to || '不限'} · 临时要求
                  </small>
                )}
              </article>
            ))}
          actions={
            state?.owner ? <button onClick={() => edit('rules')}>管理每日必做</button> : null
          }
        />
        <section className="panel">
          <header>
            <h2>工作室卫生值日</h2>
            {state?.owner && <button onClick={() => edit('duty')}>编辑值日安排</button>}
          </header>
          <p>今日值日：{state ? names(duty(state.value, state.day)) : '暂无安排'}</p>
          <p>明日值日：{state ? names(duty(state.value, plus(state.day, 1))) : '暂无安排'}</p>
          {state?.value.cleaning && <p className="studio-description">{state.value.cleaning}</p>}
          <button onClick={() => setWeek(!week)}>查看本周排班</button>
          {week &&
            state &&
            studioWeek(state.day).map((d) => (
              <p key={d}>
                {d}：{names(duty(state.value, d))}
              </p>
            ))}
        </section>
      </div>
      {mode && draft && state && (
        <Modal
          title={mode === 'rules' ? '管理每日必做' : '编辑值日安排'}
          onClose={() => {
            if (
              !busy &&
              (!pending.current ||
                confirm('保存结果尚未确认，关闭后当前草稿仍留在内存中。确认关闭？'))
            )
              setMode('');
          }}
          wide
        >
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(JSON.stringify(draft, null, 2))
                .catch(() => setError('复制失败，请保留当前表单'))
            }
          >
            复制草稿
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (confirm('确认放弃当前表单草稿并重新读取云端设置？请先复制需要保留的内容。')) {
                pending.current = null;
                setDraft(null);
                setMode('');
                void load();
              }
            }}
          >
            重新读取设置
          </button>
          <fieldset disabled={busy} className="studio-editor">
            {mode === 'rules' ? (
              <>
                <button
                  onClick={() =>
                    change({
                      ...draft,
                      rules: [
                        ...draft.rules,
                        {
                          id: crypto.randomUUID(),
                          text: '',
                          enabled: true,
                          people: [],
                          weekdays: [1, 2, 3, 4, 5],
                          from: '',
                          to: '',
                        },
                      ],
                    })
                  }
                >
                  新增工作要求
                </button>
                {draft.rules.map((r, i) => {
                  const patch = (v: any) =>
                    change({
                      ...draft,
                      rules: draft.rules.map((x, j) => (j === i ? { ...x, ...v } : x)),
                    });
                  return (
                    <article key={r.id} className="studio-rule">
                      <label>
                        工作要求
                        <textarea
                          value={r.text}
                          maxLength={2000}
                          onChange={(e) => patch({ text: e.target.value })}
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={(e) => patch({ enabled: e.target.checked })}
                        />
                        启用
                      </label>
                      <div>不选指定人员即全体员工</div>
                      {people(r.people, (people) => patch({ people }))}
                      <div>
                        {['日', '一', '二', '三', '四', '五', '六'].map((n, d) => (
                          <label key={d}>
                            <input
                              type="checkbox"
                              checked={r.weekdays.includes(d)}
                              onChange={(e) =>
                                patch({
                                  weekdays: e.target.checked
                                    ? [...r.weekdays, d]
                                    : r.weekdays.filter((x) => x !== d),
                                })
                              }
                            />
                            周{n}
                          </label>
                        ))}
                      </div>
                      <label>
                        生效日期
                        <input
                          type="date"
                          value={r.from}
                          onChange={(e) => patch({ from: e.target.value })}
                        />
                      </label>
                      <label>
                        到期日期
                        <input
                          type="date"
                          value={r.to}
                          onChange={(e) => patch({ to: e.target.value })}
                        />
                      </label>
                      <button
                        disabled={!i}
                        onClick={() => {
                          const rules = [...draft.rules];
                          [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
                          change({ ...draft, rules });
                        }}
                      >
                        上移
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('确认删除此工作要求？'))
                            change({ ...draft, rules: draft.rules.filter((x) => x.id !== r.id) });
                        }}
                      >
                        删除
                      </button>
                    </article>
                  );
                })}
              </>
            ) : (
              <>
                <label>
                  值日内容
                  <textarea
                    value={draft.cleaning}
                    maxLength={4000}
                    onChange={(e) => change({ ...draft, cleaning: e.target.value })}
                  />
                </label>
                {['日', '一', '二', '三', '四', '五', '六'].map((d, i) => (
                  <article className="studio-rule" key={d}>
                    每周{d}（不选即休息）
                    {people(draft.weekly[i], (ids) =>
                      change({ ...draft, weekly: draft.weekly.map((x, j) => (j === i ? ids : x)) }),
                    )}
                  </article>
                ))}
                <button
                  onClick={() =>
                    change({
                      ...draft,
                      exceptions: [...draft.exceptions, { date: state.day, people: [] }],
                    })
                  }
                >
                  新增指定日期／临时调班
                </button>
                {draft.exceptions.map((x, i) => (
                  <article className="studio-rule" key={i}>
                    <label>
                      指定日期
                      <input
                        type="date"
                        value={x.date}
                        onChange={(e) =>
                          change({
                            ...draft,
                            exceptions: draft.exceptions.map((v, j) =>
                              j === i ? { ...v, date: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <div>不选人员即跳过该日</div>
                    {people(x.people, (ids) =>
                      change({
                        ...draft,
                        exceptions: draft.exceptions.map((v, j) =>
                          j === i ? { ...v, people: ids } : v,
                        ),
                      }),
                    )}
                    <button
                      onClick={() =>
                        change({ ...draft, exceptions: draft.exceptions.filter((_, j) => j !== i) })
                      }
                    >
                      移除临时安排
                    </button>
                  </article>
                ))}
              </>
            )}
          </fieldset>
          <button disabled={busy} onClick={() => void save()}>
            {busy ? '保存中' : '保存设置'}
          </button>
        </Modal>
      )}
    </section>
  );
}
