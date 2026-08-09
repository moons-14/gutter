self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const path = new URL(event.request.url).pathname;
  // Reader descriptors, page bytes, and API data are always network-only. This worker owns only
  // the static shell lifecycle and deliberately never calls CacheStorage.
  if (path.startsWith('/api/reader/') || path.startsWith('/api/')) return;
});
