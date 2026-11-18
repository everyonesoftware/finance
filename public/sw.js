// Retirement endpoint for previously installed Finance workers only.
// The web app never registers this script. Keep it for returning users.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('finance-pwa-offline-'))
      .map(key => caches.delete(key)));
    await self.registration.unregister();
  })());
});
