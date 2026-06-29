const CACHE = 'qbm-hub-v3'
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.json']

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  // Never intercept Netlify function calls
  if (e.request.url.includes('/.netlify/functions/')) return
  if (e.request.method !== 'GET') return

  const url = new URL(e.request.url)
  const isHTML = url.pathname.endsWith('.html') || url.pathname.endsWith('/') || !url.pathname.includes('.')

  // HTML → network-first: always fetch fresh, fall back to cache if offline
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()))
        return res
      }).catch(() => caches.match(e.request))
    )
    return
  }

  // Assets (JS, CSS, images) → stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(res => {
        if (res.ok && res.type !== 'opaque') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()))
        }
        return res
      }).catch(() => cached)
      return cached || fresh
    })
  )
})
