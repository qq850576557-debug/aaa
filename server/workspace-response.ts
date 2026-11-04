import type { Request, Response } from 'express';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(gzip);
// Public workspace state only; session/CSRF/private endpoints and SSE are untouched.
export async function sendWorkspaceState(req: Request, res: Response, value: unknown) {
  const records = (value as { history?: { records?: { at: string }[] } })?.history?.records ?? [];
  const latest = records
    .map((r) => r.at)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort()
    .at(-1);
  if (latest) res.setHeader('X-Chunmo-Confirmed-At', latest);
  const json = JSON.stringify(value);
  res.vary('Accept-Encoding');
  if (Buffer.byteLength(json) >= 1024 && req.acceptsEncodings('gzip')) {
    const compressed = await compress(json, { level: 4 });
    res.set('Content-Encoding', 'gzip').type('application/json').send(compressed);
  } else res.type('application/json').send(json);
}
