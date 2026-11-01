import type { Request, Response } from 'express';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(gzip);
// Public workspace state only; session/CSRF/private endpoints and SSE are untouched.
export async function sendWorkspaceState(req: Request, res: Response, value: unknown) {
  const json = JSON.stringify(value);
  res.vary('Accept-Encoding');
  if (Buffer.byteLength(json) >= 1024 && req.acceptsEncodings('gzip')) {
    const compressed = await compress(json, { level: 4 });
    res.set('Content-Encoding', 'gzip').type('application/json').send(compressed);
  } else res.type('application/json').send(json);
}
