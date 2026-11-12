/* Static app shell only. Authenticated API, images and user records NEVER enter CacheStorage. */
const CACHE = 'chunmo-assistant-shell-v14';
const STATIC = [
  '/',
  '/manifest.webmanifest',
  '/brand/apple-touch-icon-v12.png',
  '/brand/pwa-192-v12.png',
  '/brand/pwa-512-v12.png',
  '/brand/pwa-maskable-v12.png',
  '/brand/source/chunmo-original.jpg',
];
self.addEventListener('install', (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC))),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('chunmo-assistant-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const req = event.request,
    url = new URL(req.url);
  if (
    req.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/download' ||
    url.pathname.startsWith('/download/')
  )
    return;
  const navigation = req.mode === 'navigate';
  if (
    !navigation &&
    !/^\/(?:assets|brand|fonts)\//.test(url.pathname) &&
    url.pathname !== '/manifest.webmanifest'
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(req);
        if (response.ok && response.type !== 'opaque')
          await cache.put(navigation ? '/' : req, response.clone());
        return response;
      } catch {
        const saved = await cache.match(navigation ? '/' : req);
        return saved || new Response('离线资源不可用，请联网重试', { status: 503 });
      }
    })(),
  );
});
