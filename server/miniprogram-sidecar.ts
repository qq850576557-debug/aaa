import express from 'express';
import http from 'node:http';
import { createMiniPhotoGateway, miniPhotoRoutes } from './miniprogram-photo';

/** Separate loopback-only adapter for older running APIs. No database client,
 * workspace endpoints, photo upload or production release replacement. */
export function createMiniPhotoSidecar(
  options: Parameters<typeof createMiniPhotoGateway>[0] & { apiPort: number },
) {
  if (!Number.isInteger(options.apiPort) || options.apiPort < 1024 || options.apiPort > 65535)
    throw Error('Invalid loopback API port');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.get('/internal/ready', (_req, res) => res.json({ ok: true, protocol: 1 }));
  app.get('/api/mini-photo/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, protocol: 1, mode: 'sidecar' });
  });
  app.use(createMiniPhotoGateway(options));
  app.use(express.json({ limit: '8kb', strict: true }));
  const allowed = new Set(
    Object.entries(miniPhotoRoutes).map(([key, path]) => key.split(' ')[0] + ' ' + path),
  );
  app.use((req, res) => {
    // Only cryptographically verified rewrites are proxied. Direct original
    // API paths and unsolicited client Origins must never bypass wx proof.
    if (
      !req.originalUrl.startsWith('/api/mini-photo/') ||
      !allowed.has(req.method + ' ' + req.path) ||
      req.get('origin') !== options.origin
    ) {
      res.status(404).json({ error: '接口不存在' });
      return;
    }
    const headers: Record<string, string> = {
      Origin: options.origin,
      'X-Forwarded-For': req.ip ?? '127.0.0.1',
    };
    for (const name of ['cookie', 'x-csrf-token', 'content-type', 'user-agent']) {
      const value = req.get(name);
      if (value) headers[name] = value;
    }
    const body = req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined;
    if (body) headers['content-length'] = String(Buffer.byteLength(body));
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: options.apiPort,
        path: req.path,
        method: req.method,
        headers,
        timeout: 20000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            response.destroy();
            upstream.destroy(Error('response limit'));
          } else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (res.writableEnded || (response.destroyed && !response.complete)) return;
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            res.status(502).json({ error: '后台返回了不允许的重定向' });
            return;
          }
          res.set('Cache-Control', 'no-store');
          for (const name of ['set-cookie', 'content-type', 'x-content-type-options']) {
            const value = response.headers[name];
            if (value) res.setHeader(name, value);
          }
          res.status(status).send(Buffer.concat(chunks));
        });
        response.on('error', () => upstream.destroy(Error('upstream response failed')));
      },
    );
    upstream.on('timeout', () => upstream.destroy(Error('timeout')));
    upstream.on('error', () => {
      if (!res.writableEnded) res.status(502).json({ error: '原后台暂不可用，请稍后重试' });
    });
    if (body) upstream.write(body);
    upstream.end();
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: '请求格式不正确' });
    },
  );
  return app;
}
