import { z } from 'zod';
import { dateOK } from './model';
const date = z.string().refine(dateOK, '请选择有效日期');
const people = z
  .array(z.string().min(1).max(100))
  .min(1)
  .max(200)
  .refine((x) => new Set(x).size === x.length, '人员不能重复');
export const rotationSchema = z
  .object({
    interval: z.union([z.literal(3), z.literal(7)]),
    people,
    start: date,
    currentDate: date,
    position: z.number().int().min(0),
    history: z
      .array(
        z.object({
          id: z.string().uuid(),
          person: z.string(),
          planned: date,
          actual: date,
          interval: z.number(),
          at: z.string(),
        }),
      )
      .max(10000),
    corrections: z
      .array(z.object({ id: z.string().uuid(), roundId: z.string(), actual: date, at: z.string() }))
      .max(10000),
  })
  .strict()
  .refine((x) => x.position < x.people.length);
export type Rotation = z.infer<typeof rotationSchema>;
const roundKey = z.object({ person: z.string().min(1).max(100), planned: date });
export const rotationCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('configure'),
    interval: z.union([z.literal(3), z.literal(7)]),
    people,
    start: date,
    currentDate: date,
  }),
  z.object({
    action: z.literal('complete'),
    round: roundKey,
    actual: date,
    reschedule: z.boolean(),
  }),
  z.object({
    action: z.literal('correctLast'),
    roundId: z.uuid(),
    actual: date,
    reschedule: z.boolean(),
  }),
]);
export type RotationCommand = z.infer<typeof rotationCommand>;
export class RotationConflict extends Error {}

const dayMs = 86400000;
const midnight = (day: string) => Date.parse(day + 'T00:00:00Z');
const addDays = (day: string, count: number) =>
  new Date(midnight(day) + count * dayMs).toISOString().slice(0, 10);
const offset = (r: Rotation, day: string) =>
  (midnight(day) - midnight(r.currentDate)) / dayMs / r.interval;
function roundAt(r: Rotation, index: number) {
  const position = (r.position + index) % r.people.length;
  return {
    position,
    person: r.people[position],
    planned: addDays(r.currentDate, index * r.interval),
  };
}
export function rotationPreview(r: Rotation, day: string, count = 3) {
  const first = Math.max(0, Math.floor(offset(r, day)));
  return Array.from({ length: count }, (_, i) => {
    const round = roundAt(r, first + i);
    return { ...round, current: i === 0 && round.planned <= day };
  });
}
export function rotationBetween(r: Rotation, from: string, to: string) {
  const first = Math.max(0, Math.ceil(offset(r, from)));
  const last = Math.floor(offset(r, to));
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => roundAt(r, first + i));
}
export function changeRotation(
  old: Rotation | undefined,
  cmd: RotationCommand,
  id: string,
  at: string,
  day: string,
): Rotation {
  if (cmd.action === 'configure')
    return rotationSchema.parse({
      interval: cmd.interval,
      people: cmd.people,
      start: cmd.start,
      currentDate: cmd.currentDate,
      position: old ? Math.max(0, cmd.people.indexOf(rotationPreview(old, day, 1)[0].person)) : 0,
      history: old?.history || [],
      corrections: old?.corrections || [],
    });
  if (!old) throw Error('请先设置参与人员和轮换日期');
  if (cmd.action === 'complete') {
    const round = rotationPreview(old, day, 1)[0];
    if (cmd.round.person !== round.person || cmd.round.planned !== round.planned)
      throw new RotationConflict('当前轮次已变化，请核对后重新确认');
    if (old.history.some((h) => h.person === round.person && h.planned === round.planned))
      throw new RotationConflict('该轮次已记录完成');
    return rotationSchema.parse({
      ...old,
      position: (round.position + 1) % old.people.length,
      currentDate: addDays(cmd.reschedule ? cmd.actual : round.planned, old.interval),
      history: [
        ...old.history,
        {
          id,
          person: round.person,
          planned: round.planned,
          actual: cmd.actual,
          interval: old.interval,
          at,
        },
      ],
    });
  }
  const last = old.history.at(-1);
  if (!last || last.id !== cmd.roundId)
    throw new RotationConflict('最近一次完成记录已变化，请核对后重新确认');
  if (cmd.reschedule) {
    const priorDates = [
      last.planned,
      last.actual,
      ...old.corrections
        .filter((correction) => correction.roundId === last.id)
        .map((correction) => correction.actual),
    ];
    if (
      old.interval !== last.interval ||
      !priorDates.some((d) => addDays(d, old.interval) === old.currentDate)
    )
      throw Error('后续排班已另行调整，请在调整轮换计划中修改排班');
  }
  return rotationSchema.parse({
    ...old,
    currentDate: cmd.reschedule ? addDays(cmd.actual, old.interval) : old.currentDate,
    corrections: [...old.corrections, { id, roundId: last.id, actual: cmd.actual, at }],
  });
}
export function effectiveActual(r: Rotation, round: Rotation['history'][number]) {
  return r.corrections.filter((x) => x.roundId === round.id).at(-1)?.actual || round.actual;
}
