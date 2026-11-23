import { useCallback, useEffect, useState, useRef } from 'react';
import { Modal } from './Modal';
import { PeoplePicker, type StudioUser } from './StudioKit';
import { useBriefExpansion } from './BriefPanel';
import { ruleActive, duty, studioWeek, type StudioSettings } from '../lib/studio-daily';
import {
  changeRotation,
  rotationPreview,
  rotationBetween,
  effectiveActual,
  type Rotation,
  type RotationCommand,
} from '../lib/studio-rotation';
import { plus } from '../lib/model';
import './studio-daily.css';
import './studio-kit.css';
type Result = {
  version: number;
  value: StudioSettings;
  users: StudioUser[];
  owner: boolean;
  day: string;
  serverTime: number;
};
export function StudioDaily({ cloud, compact = false }: { cloud: boolean; compact?: boolean }) {
  const [rulesExpanded, setRulesExpanded] = useBriefExpansion('studio-rules');
  const [state, setState] = useState<Result | null>(null),
    [mode, setMode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [weekOffset, setWeekOffset] = useState(0);
  const [ruleId, setRuleId] = useState(''),
    [text, setText] = useState(''),
    [people, setPeople] = useState<string[]>([]);
  const [interval, setInterval] = useState<3 | 7>(3),
    [start, setStart] = useState(''),
    [planned, setPlanned] = useState(''),
    [actual, setActual] = useState(''),
    [action, setAction] = useState<RotationCommand['action']>('configure'),
    [reschedule, setReschedule] = useState(false),
    [draftBase, setDraftBase] = useState<Result | null>(null);
  const pending = useRef<any>(null);
  const newRuleId = useRef('');
  const retainedMode = useRef('');
  const dirty = useRef(false);
  const draftVersion = useRef(0);
  const loadId = useRef(0);
  useEffect(() => {
    const protect = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);
  const load = useCallback(async (): Promise<Result | undefined> => {
    const id = ++loadId.current;
    try {
      const r = await fetch('/api/studio-daily', { cache: 'no-store' });
      const body: Result & { error?: string } = await r.json();
      if (!r.ok) throw Error(body.error || '工作室日常读取失败');
      if (id !== loadId.current) return;
      setState(body);
      if (!dirty.current) setError('');
      return body;
    } catch (e) {
      if (id === loadId.current && !dirty.current) setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!cloud) return;
    void load();
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) void load();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restored);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', restored);
    };
  }, [cloud, load]);
  useEffect(() => {
    if (!cloud || !state?.serverTime) return;
    const midnight = Date.parse(plus(state.day, 1) + 'T00:00:00+08:00');
    const timer = window.setTimeout(() => void load(), Math.max(0, midnight - state.serverTime));
    return () => window.clearTimeout(timer);
  }, [cloud, load, state]);
  const name = (id: string) => state?.users.find((u) => u.id === id)?.name || '已停用账号';
  const rotation = state?.value.rotation;
  function openRule(id = '') {
    if (!state?.owner) return;
    if (!id && retainedMode.current === 'rules') {
      setMode('rules');
      return;
    }
    if (dirty.current && !confirm('切换后将放弃尚未保存的输入，继续吗？')) return;
    dirty.current = false;
    retainedMode.current = 'rules';
    draftVersion.current = state.version;
    const r = state.value.rules.find((x) => x.id === id);
    setRuleId(id);
    newRuleId.current = crypto.randomUUID();
    setText(r?.text || '');
    setPeople(r?.people || []);
    pending.current = null;
    setError('');
    setMode('rules');
  }
  const initializeDuty = useCallback((source: Result) => {
    const r = source.value.rotation;
    const current = r ? rotationPreview(r, source.day, 1)[0] : undefined;
    setDraftBase(source);
    draftVersion.current = source.version;
    setPeople(r?.people || []);
    setInterval(r?.interval || 3);
    setStart(r?.start || source.day);
    setPlanned(current?.planned || source.day);
    setActual(source.day);
    setAction('configure');
    setReschedule(false);
  }, []);
  useEffect(() => {
    if (state && !dirty.current && !pending.current && retainedMode.current === 'duty')
      initializeDuty(state);
  }, [initializeDuty, state]);
  function openDuty() {
    if (!state?.owner) return;
    if (retainedMode.current === 'duty') {
      setMode('duty');
      return;
    }
    if (dirty.current && !confirm('切换后将放弃尚未保存的输入，继续吗？')) return;
    dirty.current = false;
    retainedMode.current = 'duty';
    initializeDuty(state);
    pending.current = null;
    setError('');
    setMode('duty');
  }
  const draftRotation = draftBase?.value.rotation;
  const selected =
    draftRotation && draftBase ? rotationPreview(draftRotation, draftBase.day, 1)[0] : undefined;
  const last = draftRotation?.history.at(-1);
  let command: RotationCommand | undefined;
  if (action === 'configure') command = { action, interval, people, start, currentDate: planned };
  if (action === 'complete' && selected)
    command = {
      action,
      actual,
      reschedule,
      round: { person: selected.person, planned: selected.planned },
    };
  if (action === 'correctLast' && last) command = { action, actual, reschedule, roundId: last.id };
  let preview: Rotation | undefined;
  let previewError = '';
  try {
    if (mode === 'duty' && draftBase && command)
      preview = changeRotation(
        draftRotation,
        command,
        '00000000-0000-4000-8000-000000000000',
        new Date().toISOString(),
        draftBase.day,
      );
  } catch (e) {
    if (action !== 'configure' && actual) previewError = (e as Error).message;
  }
  async function submit(value: unknown, rot = false) {
    if (!state?.owner || busy) return;
    setBusy(true);
    try {
      const session = await (await fetch('/api/auth/session')).json();
      const fingerprint = JSON.stringify({ rot, value });
      if (!pending.current || pending.current.fingerprint !== fingerprint)
        pending.current = {
          fingerprint,
          body: { requestId: crypto.randomUUID(), version: draftVersion.current, value },
        };
      const r = await fetch('/api/studio-daily' + (rot ? '/rotation' : ''), {
        method: rot ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: JSON.stringify(pending.current.body),
      });
      const ack = await r.json();
      if (r.status === 409) {
        const latest = await load();
        pending.current = null;
        if (!latest) throw Error('设置或轮次已变化，重新读取失败；输入仍保留。');
        draftVersion.current = latest.version;
        if (rot) setDraftBase(latest);
        throw Error('设置已更新，已读取最新版本；输入仍保留，请核对工作要求或当前轮次后重新保存。');
      }
      if (!r.ok) throw Error(ack.error || '保存失败，输入内容保留');
      if (!Number.isInteger(ack.version)) throw Error('未收到云端确认，请重试');
      pending.current = null;
      retainedMode.current = '';
      dirty.current = false;
      setMode('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function saveRule() {
    if (!state || !text.trim()) {
      setError('请填写工作要求');
      return;
    }
    const old = state.value.rules.find((r) => r.id === ruleId);
    if (ruleId && !old) {
      setError('这条要求已被删除，输入仍保留，请核对后新增。');
      return;
    }
    const r = old
      ? { ...old, text: text.trim(), people }
      : {
          id: newRuleId.current,
          text: text.trim(),
          people,
          enabled: true,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          from: '',
          to: '',
        };
    const rules = old
      ? state.value.rules.map((x) => (x.id === ruleId ? r : x))
      : [...state.value.rules, r];

    void submit({ ...state.value, rules });
  }
  if (!cloud) return <section className="panel">工作室日常需登录云端账号后使用。</section>;
  const active = (state?.value.rules || []).filter((r) => ruleActive(r, state!.day));
  const visibleRules = compact ? active.slice(0, 2) : active;
  const ruleLines = (rules: typeof active) =>
    rules.map((r) => (
      <div className="sd-rule-line" key={r.id}>
        <span className="sd-dot" aria-hidden="true" />
        <p>{r.text}</p>
      </div>
    ));
  const next = rotation && state ? rotationPreview(rotation, state.day) : [];
  const week = state ? studioWeek(plus(state.day, weekOffset * 7)) : [];
  return (
    <section className="studio-ui sd-section">
      <h2>工作室日常</h2>
      {error && !mode && (
        <div className="sd-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      )}
      <div className="sd-grid">
        <section className="sd-card sd-rules" data-testid="studio-rules">
          <header className="sd-card-head">
            <h2>
              每日必做 <span className="sd-count">{active.length}</span>
            </h2>
            {compact ? (
              active.length > 0 && (
                <button
                  className="sd-secondary"
                  aria-haspopup="dialog"
                  onClick={() => setMode('view')}
                >
                  展开查看
                </button>
              )
            ) : (
              <button
                className="sd-secondary"
                aria-expanded={rulesExpanded}
                aria-label={`${rulesExpanded ? '收起' : '展开'}每日必做`}
                onClick={() => setRulesExpanded((v) => !v)}
              >
                {rulesExpanded ? '收起' : '展开'}
              </button>
            )}
          </header>
          <div className="sd-card-content">
            {(compact || rulesExpanded) &&
              (active.length ? ruleLines(visibleRules) : <p className="sd-empty">暂无工作要求</p>)}
          </div>
          <footer className="sd-card-foot">
            {state?.owner && (
              <button className="sd-secondary" onClick={() => openRule()}>
                管理每日必做
              </button>
            )}
          </footer>
        </section>
        <section className="sd-card sd-duty">
          <header className="sd-card-head">
            <h2>卫生值日</h2>
            <div className="sd-actions">
              <button
                className="sd-secondary"
                onClick={() => {
                  setWeekOffset(0);
                  setMode('schedule');
                }}
              >
                查看排班
              </button>
              {state?.owner && (
                <button className="sd-primary" onClick={openDuty}>
                  编辑值日
                </button>
              )}
            </div>
          </header>
          <div className="sd-card-content">
            {rotation ? (
              <>
                <p className="sd-caption">
                  {next[0].current ? '当前轮值' : '待轮值'} · 每{rotation.interval}天轮换
                </p>
                <strong className="sd-person">{name(next[0].person)}</strong>
                <p>计划打扫　{next[0].planned}</p>
                <div className="sd-next">
                  下一位：{name(next[1].person)}
                  <span>{next[1].planned} · 计划</span>
                </div>
              </>
            ) : (
              <>
                <p className="sd-empty">暂无轮换安排</p>
                {state && (
                  <small>
                    原周排班：今日 {duty(state.value, state.day).map(name).join('、') || '暂无安排'}
                    ；明日{' '}
                    {duty(state.value, plus(state.day, 1)).map(name).join('、') || '暂无安排'}
                  </small>
                )}
              </>
            )}
          </div>
          <footer
            className="sd-card-foot"
            data-empty={compact && rotation && !rotation.history.length ? '' : undefined}
          >
            {rotation?.history.length ? (
              <small>
                最近完成：{name(rotation.history.at(-1)!.person)} ·{' '}
                {effectiveActual(rotation, rotation.history.at(-1)!)}
              </small>
            ) : !compact || !rotation ? (
              <small>{rotation ? `每${rotation.interval}天一人` : '尚未开始轮换'}</small>
            ) : null}
          </footer>
        </section>
      </div>
      {mode && (
        <Modal
          title={mode === 'duty' ? '编辑值日' : mode === 'schedule' ? '值日排班' : '每日必做'}
          className="studio-ui sd-modal"
          blocking
          enhancedGlass={mode === 'duty'}
          wide={mode === 'rules'}
          onClose={() => {
            if (!busy) setMode('');
          }}
        >
          <div className="modal-body">
            {error && (mode === 'rules' || mode === 'duty') && (
              <p className="sd-error" role="alert">
                {error}
              </p>
            )}
            {mode === 'view' && <div className="sd-rules-full">{ruleLines(active)}</div>}
            {mode === 'rules' && state?.owner && (
              <fieldset
                disabled={busy}
                className="sd-fieldset sd-rule-manager"
                onChangeCapture={() => {
                  dirty.current = true;
                }}
              >
                <aside>
                  <button
                    className="sd-secondary"
                    disabled={busy}
                    onClick={() => {
                      if (!dirty.current || confirm('新建要求将放弃尚未保存的输入，继续吗？')) {
                        retainedMode.current = '';
                        dirty.current = false;
                        openRule();
                      }
                    }}
                  >
                    新增要求
                  </button>
                  {state.value.rules.map((r) => (
                    <button
                      disabled={busy}
                      className={ruleId === r.id ? 'selected' : ''}
                      key={r.id}
                      onClick={() => openRule(r.id)}
                    >
                      <span className="sd-rule-title" title={r.text}>
                        {r.text}
                      </span>
                    </button>
                  ))}
                </aside>
                <div className="sd-form">
                  <label>
                    工作要求
                    <textarea
                      aria-label="工作要求"
                      className="sd-input"
                      value={text}
                      maxLength={2000}
                      disabled={busy}
                      placeholder="填写希望员工每天看到的工作要求"
                      onChange={(e) => setText(e.target.value)}
                    />
                  </label>
                  <label>关联员工</label>
                  <PeoplePicker
                    users={state.users}
                    value={people}
                    onChange={(ids) => {
                      dirty.current = true;
                      setPeople(ids);
                    }}
                    all
                  />
                  <footer>
                    {ruleId && state.value.rules.some((r) => r.id === ruleId) && (
                      <button
                        className="sd-danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm('确认删除这条工作要求？'))
                            void submit({
                              ...state.value,
                              rules: state.value.rules.filter((r) => r.id !== ruleId),
                            });
                        }}
                      >
                        删除要求
                      </button>
                    )}
                    <button className="sd-primary" disabled={busy} onClick={saveRule}>
                      {busy ? '保存中' : '保存'}
                    </button>
                  </footer>
                </div>
              </fieldset>
            )}
            {mode === 'duty' && state?.owner && (
              <fieldset
                disabled={busy}
                className="sd-fieldset sd-form"
                onChangeCapture={() => {
                  dirty.current = true;
                }}
              >
                <label>
                  本次操作
                  <select
                    aria-label="本次操作"
                    className="sd-input"
                    value={action}
                    onChange={(e) => {
                      setAction(e.target.value as RotationCommand['action']);
                      setReschedule(false);
                    }}
                    disabled={busy}
                  >
                    <option value="configure">
                      {draftRotation ? '调整轮换计划' : '首次设置轮换'}
                    </option>
                    <option value="complete" disabled={!selected}>
                      记录本轮完成
                    </option>
                    <option value="correctLast" disabled={!last}>
                      修正最近一次完成日期
                    </option>
                  </select>
                </label>
                {action === 'configure' ? (
                  <>
                    <label>参与人员 · 按选择顺序轮换</label>
                    <PeoplePicker
                      users={state.users}
                      value={people}
                      onChange={(ids) => {
                        dirty.current = true;
                        setPeople(ids);
                      }}
                    />
                    <div className="sd-row sd-rotation-dates">
                      <label>
                        轮换周期
                        <select
                          aria-label="轮换周期"
                          className="sd-input"
                          value={interval}
                          onChange={(e) => setInterval(Number(e.target.value) as 3 | 7)}
                        >
                          <option value={3}>每3天一人</option>
                          <option value={7}>每7天一人</option>
                        </select>
                      </label>
                      <label>
                        {draftRotation ? '当前轮次计划日期' : '起始日期'}
                        <input
                          className="sd-input"
                          type="date"
                          aria-label={draftRotation ? '当前轮次计划日期' : '起始日期'}
                          value={draftRotation ? planned : start}
                          onChange={(e) => {
                            if (!draftRotation) setStart(e.target.value);
                            setPlanned(e.target.value);
                          }}
                        />
                      </label>
                    </div>
                  </>
                ) : (
                  <>
                    <label>
                      <span className="sd-caption">
                        {action === 'complete'
                          ? selected && `本轮：${name(selected.person)} · 计划 ${selected.planned}`
                          : last &&
                            draftRotation &&
                            `最近完成：${name(last.person)} · ${effectiveActual(draftRotation, last)}`}
                      </span>
                      <br />
                      实际完成日期
                      <input
                        aria-label="实际完成日期"
                        className="sd-input"
                        type="date"
                        value={actual}
                        onChange={(e) => setActual(e.target.value)}
                      />
                    </label>
                    <div className="sd-person-choice">
                      <label>
                        <input
                          type="checkbox"
                          checked={reschedule}
                          onChange={(e) => setReschedule(e.target.checked)}
                        />
                        <span>按实际完成日期重新安排后续排班</span>
                      </label>
                    </div>
                  </>
                )}
                <div className="sd-preview">
                  <h3>保存后的排班预览</h3>
                  {preview && draftBase ? (
                    rotationPreview(preview, draftBase.day).map((p, i) => (
                      <div key={i}>
                        <span>{name(p.person)}</span>
                        <time>{p.planned}</time>
                        <small>{i ? '计划' : p.current ? '当前轮次' : '待轮值'}</small>
                      </div>
                    ))
                  ) : (
                    <p>{previewError || '请选择人员并填写有效日期'}</p>
                  )}
                </div>
                <footer>
                  <button
                    className="sd-primary"
                    disabled={busy || !preview}
                    onClick={() => void submit(command, true)}
                  >
                    {busy ? '保存中' : '确认预览并保存'}
                  </button>
                </footer>
              </fieldset>
            )}
            {mode === 'schedule' && state && (
              <div className="sd-schedule">
                <div className="sd-actions">
                  <button className="sd-secondary" onClick={() => setWeekOffset((v) => v - 1)}>
                    上周
                  </button>
                  <strong>
                    {week[0]} — {week[6]}
                  </strong>
                  <button className="sd-secondary" onClick={() => setWeekOffset((v) => v + 1)}>
                    下周
                  </button>
                </div>
                {rotation ? (
                  <>
                    {rotation.history
                      .filter((h) => {
                        const d = effectiveActual(rotation, h);
                        return d >= week[0] && d <= week[6];
                      })
                      .map((h) => (
                        <div className="sd-schedule-row" key={h.id}>
                          <strong>{name(h.person)}</strong>
                          <span>原计划 {h.planned}</span>
                          <span>实际 {effectiveActual(rotation, h)} · 已完成</span>
                        </div>
                      ))}
                    {rotationBetween(rotation, week[0], week[6])
                      .filter(
                        (p) =>
                          p.planned >= week[0] &&
                          p.planned <= week[6] &&
                          !next.some((n) => n.person === p.person && n.planned === p.planned),
                      )
                      .map((p, i) => (
                        <div className="sd-schedule-row" key={i}>
                          <strong>{name(p.person)}</strong>
                          <span>{p.planned}</span>
                          <span>{p.planned < state.day ? '原计划' : '计划'}</span>
                        </div>
                      ))}
                    <section className="sd-upcoming" aria-label="近期三轮值日">
                      <h3>近期轮值</h3>
                      {next.map((p, i) => (
                        <div className="sd-schedule-row" key={i}>
                          <strong>{name(p.person)}</strong>
                          <time dateTime={p.planned}>{p.planned}</time>
                          <span>{[p.current ? '当前轮次' : '待轮值', '下一轮', '下下轮'][i]}</span>
                        </div>
                      ))}
                    </section>
                  </>
                ) : (
                  week.map((d) => (
                    <div className="sd-schedule-row" key={d}>
                      <time>{d}</time>
                      <span>{duty(state.value, d).map(name).join('、') || '暂无安排'}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
