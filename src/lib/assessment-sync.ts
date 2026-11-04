import { rememberAssessment } from './assessment-undo';
import { cloudApi } from './cloud';
import {
  outboxDB,
  verifiedOwner,
  pendingRecords,
  queueRecord,
  finishSupersededRecord,
  signalOutbox,
  type Owner,
} from './record-outbox';
import {
  checkFields,
  dailyKey,
  type Assessment,
  type AssessmentKey,
  type CheckField,
  type CheckStatus,
} from './assessments';
export type AssessmentTarget = Omit<AssessmentKey, 'tradeId'> & {
  personName: string;
  projectName: string;
  sources: Assessment[];
};
type Intent = { value: CheckStatus; stamp: string };
type Body = {
  requestId: string;
  confirmed: true;
  edits: {
    date: string;
    personId: string;
    projectId: string;
    tradeId: string;
    version: number;
    changes: Partial<Record<CheckField, CheckStatus>>;
  }[];
};
export type AssessmentDraft = {
  owner: Owner;
  target: AssessmentTarget;
  fields: Partial<Record<CheckField, Intent>>;
  inFlight?: { body: Body; stamps: Partial<Record<CheckField, string>> };
  blocked?: { status: number; message: string };
  superseded?: string[];
};
const storageKey = (owner: Owner, row: AssessmentTarget) =>
  JSON.stringify([owner.workspaceId, owner.id, dailyKey(row)]);
const flights = new Map<string, Promise<void>>();
// Bridge the brief interval between durable acknowledgement and React's next
// render. A click from the old row must use our confirmed version, not create v0.
const acknowledged = new Map<string, Assessment[]>();
function knownSources(owner: Owner, target: AssessmentTarget) {
  const rows = new Map((acknowledged.get(storageKey(owner, target)) ?? []).map((r) => [r.id, r]));
  for (const row of target.sources)
    if (!rows.has(row.id) || rows.get(row.id)!.version < row.version) rows.set(row.id, row);
  return [...rows.values()];
}
const sameOwner = (owner: Owner) => {
  const live = verifiedOwner();
  return live?.id === owner.id && live.workspaceId === owner.workspaceId;
};
function changed() {
  window.dispatchEvent(new Event('chunmo-assessment-drafts'));
}
export async function assessmentDrafts(owner = verifiedOwner()): Promise<AssessmentDraft[]> {
  if (!owner) return [];
  const db = await outboxDB();
  try {
    return (await db.getAll('assessmentDrafts')).filter(
      (d: AssessmentDraft) => d.owner.id === owner.id && d.owner.workspaceId === owner.workspaceId,
    );
  } finally {
    db.close();
  }
}
async function mutate(
  owner: Owner,
  target: AssessmentTarget,
  fn: (old: AssessmentDraft | undefined) => AssessmentDraft | undefined,
) {
  const db = await outboxDB();
  try {
    const tx = db.transaction('assessmentDrafts', 'readwrite');
    const key = storageKey(owner, target);
    const next = fn(await tx.store.get(key));
    if (next) await tx.store.put(next, key);
    else await tx.store.delete(key);
    await tx.done;
    changed();
    return next;
  } finally {
    db.close();
  }
}
export async function setAssessmentIntent(
  target: AssessmentTarget,
  changes: Partial<Record<CheckField, CheckStatus>>,
  captureUndo = true,
) {
  const owner = verifiedOwner();
  if (!owner) throw Error('请先登录再记录考核');
  let previous: Partial<Record<CheckField, CheckStatus>> = {};
  const next = await mutate(owner, target, (old) => {
    const row: AssessmentDraft = old ?? {
      owner: { ...owner },
      target: { ...structuredClone(target), sources: knownSources(owner, target) },
      fields: {},
    };
    previous = Object.fromEntries(
      checkFields.map((f) => [f, row.fields[f]?.value ?? row.target.sources[0]?.[f] ?? 'pending']),
    );
    for (const f of checkFields)
      if (changes[f] !== undefined)
        row.fields[f] = { value: changes[f]!, stamp: crypto.randomUUID() };
    return row;
  });
  if (captureUndo) rememberAssessment(target, previous, changes);
  signalOutbox('本地已保存，正在上传');
  if (next) void syncDraft(next);
}
async function syncDraft(initial: AssessmentDraft): Promise<void> {
  const key = storageKey(initial.owner, initial.target);
  if (flights.has(key)) return flights.get(key)!;
  let immediateWake = true;
  const task = (async () => {
    while (sameOwner(initial.owner)) {
      let row = (await assessmentDrafts(initial.owner)).find(
        (d) => storageKey(d.owner, d.target) === key,
      );
      if (!row || row.blocked) return;
      if (!row.inFlight) {
        row = await mutate(row.owner, row.target, (current) => {
          if (!current || current.blocked || current.inFlight) return current;
          const changes = Object.fromEntries(
            checkFields.filter((f) => current.fields[f]).map((f) => [f, current.fields[f]!.value]),
          );
          if (!Object.keys(changes).length) return undefined;
          if (current.target.sources.length > 100)
            return {
              ...current,
              blocked: {
                status: 400,
                message: '该日旧记录超过100条，未改动数据；请先分批核对来源记录。',
              },
            };
          const identity = {
            date: current.target.date,
            personId: current.target.personId,
            projectId: current.target.projectId,
          };
          return {
            ...current,
            inFlight: {
              stamps: Object.fromEntries(
                checkFields
                  .filter((f) => current.fields[f])
                  .map((f) => [f, current.fields[f]!.stamp]),
              ),
              body: {
                requestId: crypto.randomUUID(),
                confirmed: true,
                edits: current.target.sources.length
                  ? current.target.sources.map((r) => ({
                      date: r.date,
                      personId: r.personId,
                      projectId: r.projectId,
                      tradeId: r.tradeId,
                      version: r.version,
                      changes,
                    }))
                  : [{ ...identity, tradeId: 'daily', version: 0, changes }],
              },
            },
          };
        });
      }
      if (!row?.inFlight || row.blocked) return;
      const flight = row.inFlight;
      try {
        // The immutable flight is stored before enqueue. A crash at either side
        // replays the same receipt; later local clicks remain separate intents.
        const queued = await queueRecord('/assessments/batch', 'POST', flight.body);
        const result = (await queued.completion) as { records: Assessment[] };
        acknowledged.delete(key);
        acknowledged.set(key, knownSources(row.owner, { ...row.target, sources: result.records }));
        if (acknowledged.size > 1000) acknowledged.delete(acknowledged.keys().next().value!);
        const superseded = row.superseded ?? [];
        await mutate(row.owner, row.target, (current) => {
          if (!current || current.inFlight?.body.requestId !== flight.body.requestId)
            return current;
          for (const f of checkFields)
            if (current.fields[f]?.stamp === flight.stamps[f]) delete current.fields[f];
          current.target.sources = result.records;
          delete current.inFlight;
          delete current.blocked;
          delete current.superseded;
          return Object.keys(current.fields).length ? current : undefined;
        });
        if (sameOwner(row.owner)) {
          for (const id of superseded) await finishSupersededRecord(id);
          window.dispatchEvent(
            new CustomEvent('chunmo-assessment-confirmed', {
              detail: { owner: row.owner, records: result.records },
            }),
          );
          const pending = await assessmentDrafts(row.owner);
          const otherPending = await pendingRecords(row.owner);
          signalOutbox(
            pending.some((d) => d.blocked) || otherPending.some((d) => d.blocked)
              ? '考核存在待处理冲突，本地内容已保留'
              : pending.length || otherPending.length
                ? '本地已保存，正在上传'
                : '云端已保存',
          );
        }
      } catch (e) {
        const status = (e as { status?: number }).status ?? 0;
        await mutate(
          row.owner,
          row.target,
          (current) =>
            current && {
              ...current,
              blocked: { status, message: e instanceof Error ? e.message : String(e) },
            },
        );
        return;
      }
    }
  })()
    .catch(() => {
      immediateWake = false;
      signalOutbox('考核本地保存异常，请保留页面并备份');
    })
    .finally(() => {
      flights.delete(key);
      // An edit can land after the last empty read but before this flight exits.
      // Recheck durable state so it never waits for the periodic wake-up.
      if (immediateWake && sameOwner(initial.owner))
        void assessmentDrafts(initial.owner)
          .then((rows) => {
            const next = rows.find((r) => storageKey(r.owner, r.target) === key);
            if (next && !next.blocked) void syncDraft(next);
          })
          .catch(() => signalOutbox('考核本地读取异常，请保留页面并备份'));
    });
  flights.set(key, task);
  return task;
}
export async function retryAssessmentIntent(draft: AssessmentDraft, latest: Assessment[]) {
  const owner = verifiedOwner();
  if (!owner || !sameOwner(draft.owner)) throw Error('请使用原账号处理待同步考核');
  const next = await mutate(owner, draft.target, (current) => {
    if (!current?.blocked) return current;
    return {
      ...current,
      target: { ...current.target, sources: latest },
      inFlight: undefined,
      blocked: undefined,
      superseded: [
        ...(current.superseded ?? []),
        ...(current.inFlight ? [current.inFlight.body.requestId] : []),
      ],
    };
  });
  if (next) void syncDraft(next);
}
let started = false;
export async function startAssessmentSync(owner: Owner) {
  if (!sameOwner(owner)) return;
  const wake = async () => {
    const live = verifiedOwner();
    if (!live) return;
    for (const draft of await assessmentDrafts(live)) void syncDraft(draft);
  };
  if (!started) {
    started = true;
    window.addEventListener('online', () => {
      void wake().catch(() => {});
    });
    window.addEventListener('focus', () => {
      void wake().catch(() => {});
    });
    setInterval(() => {
      void wake().catch(() => {});
    }, 30000);
  }
  // Reauthentication can resume the exact failed receipt; a genuine version
  // conflict or revoked recorder grant still requires explicit review.
  for (const draft of await assessmentDrafts(owner)) {
    if (draft.blocked?.status === 401 || draft.blocked?.status === 0)
      await mutate(owner, draft.target, (d) => d && { ...d, blocked: undefined });
  }
  await wake();
}
export async function readAllAssessments(to: string) {
  const records: Assessment[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ from: '1900-01-01', to, ...(cursor ? { cursor } : {}) });
    const page: { records: Assessment[]; nextCursor: string | null } = await cloudApi(
      '/assessments?' + q,
    );
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}
