// Only this public, data-free page is stored. Never add the authenticated app shell.
export const serviceWorkerTemplate = `// Finance build __FINANCE_BUILD_ID__
'use strict';
const CACHE_PREFIX = 'finance-pwa-offline-';
const CACHE_NAME = CACHE_PREFIX + '__FINANCE_BUILD_ID__';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(OFFLINE_URL, {
      cache: 'reload', credentials: 'omit', redirect: 'error'
    });
    if (!response.ok || response.redirected ||
        !response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('Public offline page unavailable');
    }
    const cache = await caches.open(CACHE_NAME);
    await cache.put(OFFLINE_URL, response);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Updates keep waiting while an existing client is open. Only user approval bypasses that.
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return; }
  if (/^\\/api(?:\\/|$)/i.test(path)) return;
  event.respondWith((async () => {
    try {
      // Never write network responses (which may be authenticated) into Cache Storage.
      return await fetch(request, { cache: 'no-store' });
    } catch {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(OFFLINE_URL) || new Response('Finance is disconnected. Reconnect and retry.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  })());
});
`;
