import { addYears, format, parseISO } from 'date-fns';
import { projectRange, today, type Data, type Project } from './model';
export function timelineRange(data: Data, project: Project, now = today()): [string, string] {
  const [a, b] = projectRange(data, project);
  return [[a, now].sort()[0], [b, format(addYears(parseISO(now), 5), 'yyyy-MM-dd')].sort().at(-1)!];
}
export function timelineWindow(scroll: number, width: number, count: number) {
  const first = Math.max(0, Math.floor(scroll / 56) - 4);
  const last = Math.min(count, Math.ceil((scroll + width) / 56) + 5);
  return { first, last };
}
