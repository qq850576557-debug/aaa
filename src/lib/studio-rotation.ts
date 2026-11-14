import { z } from 'zod';
import { dateOK, plus } from './model';
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
export const rotationCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('configure'),
    interval: z.union([z.literal(3), z.literal(7)]),
    people,
    start: date,
    currentDate: date,
  }),
  z.object({ action: z.literal('complete'), actual: date }),
  z.object({ action: z.literal('correctLast'), actual: date }),
]);
export function changeRotation(
  old: Rotation | undefined,
  cmd: z.infer<typeof rotationCommand>,
  id: string,
  at: string,
): Rotation {
  if (cmd.action === 'configure')
    return rotationSchema.parse({
      interval: cmd.interval,
      people: cmd.people,
      start: cmd.start,
      currentDate: cmd.currentDate,
      position: old ? Math.max(0, cmd.people.indexOf(old.people[old.position])) : 0,
      history: old?.history || [],
      corrections: old?.corrections || [],
    });
  if (!old) throw Error('请先设置参与人员和轮换日期');
  if (cmd.action === 'complete')
    return rotationSchema.parse({
      ...old,
      position: (old.position + 1) % old.people.length,
      currentDate: plus(cmd.actual, old.interval),
      history: [
        ...old.history,
        {
          id,
          person: old.people[old.position],
          planned: old.currentDate,
          actual: cmd.actual,
          interval: old.interval,
          at,
        },
      ],
    });
  const last = old.history.at(-1);
  if (!last) throw Error('暂无可修正的完成记录');
  return rotationSchema.parse({
    ...old,
    currentDate: plus(cmd.actual, old.interval),
    corrections: [...old.corrections, { id, roundId: last.id, actual: cmd.actual, at }],
  });
}
export function rotationPreview(r: Rotation, count = 8) {
  return Array.from({ length: count }, (_, i) => ({
    person: r.people[(r.position + i) % r.people.length],
    planned: plus(r.currentDate, i * r.interval),
    current: i === 0,
  }));
}
export function effectiveActual(r: Rotation, round: Rotation['history'][number]) {
  return r.corrections.filter((x) => x.roundId === round.id).at(-1)?.actual || round.actual;
}
