/** Local, bounded browser measurements only: never records coordinates, names or image bytes. */
export function photoTiming(name: string, start: number, detail?: Record<string, string | number>) {
  const key = `chunmo-photo:${name}`;
  try {
    performance.measure(key, { start, end: performance.now(), detail });
    const entries = performance.getEntriesByName(key, 'measure');
    if (entries.length > 60) performance.clearMeasures(key);
  } catch {
    /* Older Safari may not implement measure options. */
  }
}
export async function photoStage<T>(
  name: string,
  work: () => Promise<T>,
  detail?: Record<string, string | number>,
) {
  const start = performance.now();
  try {
    return await work();
  } finally {
    photoTiming(name, start, detail);
  }
}
