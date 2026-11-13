import { createMiniPhotoSidecar } from './miniprogram-sidecar';

// This entry point deliberately never imports server/config, database pools,
// migrations or the main server. Only this service's minimal environment is read.
function start() {
  const env = process.env;
  const appId = env.CHUNMO_MINI_APP_ID ?? '';
  const appSecret = env.CHUNMO_MINI_APP_SECRET ?? '';
  const signingKey = env.CHUNMO_MINI_SIGNING_KEY ?? '';
  const origin = env.CHUNMO_MINI_ORIGIN ?? '';
  const apiPort = Number(env.CHUNMO_MINI_API_PORT);
  const port = Number(env.CHUNMO_MINI_PORT);
  if (
    !/^wx[a-z0-9]{16}$/i.test(appId) ||
    !/^[a-f0-9]{32}$/i.test(appSecret) ||
    !/^[a-f0-9]{64}$/i.test(signingKey) ||
    origin !== 'https://chmsj.cn' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    apiPort === port
  )
    throw Error('Invalid private service configuration');
  const app = createMiniPhotoSidecar({
    enabled: true,
    appId,
    appSecret,
    signingKey,
    origin,
    apiPort,
  });
  const server = app.listen(port, '127.0.0.1', () =>
    console.info('Chunmo mini-photo loopback adapter ready'),
  );
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    console.error('Mini-photo listener unavailable');
    process.exitCode = 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      server.close(() => {
        process.exitCode = 0;
      });
      setTimeout(() => process.exit(0), 25000).unref();
    });
}
try {
  start();
} catch {
  // Never log environment, configuration values or an exception containing them.
  console.error('Mini-photo startup failed: check private configuration');
  process.exitCode = 1;
}
