// Only public offline assets are cached. Team YAML, archive evidence, and API responses
// always stay on the network and never enter the service worker's cache.
const CACHE = 'loomwatch-offline-v1'
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/offline.html', '/icon.svg'])))
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('loomwatch-offline-') && key !== CACHE).map((key) => caches.delete(key)))))
})
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')))
  } else if (url.pathname === '/icon.svg') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/icon.svg')))
  }
})
