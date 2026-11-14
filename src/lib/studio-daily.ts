import { z } from 'zod';
import { dateOK, plus } from './model';
const date = z.string().refine((v) => v === '' || dateOK(v));
const ids = z
  .array(z.string().min(1).max(100))
  .max(200)
  .refine((x) => new Set(x).size === x.length);
export const dailyRule = z
  .object({
    id: z.string().uuid(),
    text: z.string().trim().min(1).max(2000),
    enabled: z.boolean(),
    people: ids,
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    from: date,
    to: date,
  })
  .strict()
  .refine((r) => !r.from || !r.to || r.from <= r.to, '日期范围无效');
export const studioSettings = z
  .object({
    rules: z
      .array(dailyRule)
      .max(200)
      .refine((x) => new Set(x.map((r) => r.id)).size === x.length),
    weekly: z.array(ids).length(7),
    exceptions: z
      .array(z.object({ date: z.string().refine(dateOK), people: ids }).strict())
      .max(400)
      .refine((x) => new Set(x.map((r) => r.date)).size === x.length),
    cleaning: z.string().max(4000),
  })
  .strict();
export type StudioSettings = z.infer<typeof studioSettings>;
export const emptyStudio = (): StudioSettings => ({
  rules: [],
  weekly: Array.from({ length: 7 }, () => []),
  exceptions: [],
  cleaning: '',
});
export const studioDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export const weekDay = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();
export const ruleActive = (r: StudioSettings['rules'][number], day: string) =>
  r.enabled &&
  (!r.from || r.from <= day) &&
  (!r.to || r.to >= day) &&
  r.weekdays.includes(weekDay(day));
export const duty = (s: StudioSettings, day: string) =>
  s.exceptions.find((x) => x.date === day)?.people ?? s.weekly[weekDay(day)];
export function studioWeek(day: string) {
  const offset = (weekDay(day) + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => plus(day, i - offset));
}
