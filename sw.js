// Baal Shravan — Service Worker
// Caches the app shell so it loads instantly and works offline.
// Audio streams from Google Drive are never cached (too large).
//
// VERSIONING: bump CACHE whenever you deploy new app files so that
// home-screen users get the update on their next visit.

const CACHE = 'baal-shravan-v2';

// Static assets — cache-first (safe: only change when CACHE is bumped)
const SHELL = [
  '/styles.css',
  '/app.js',
  '/stories-data.js',
  '/firebase-config.js',
  '/baal.png',
];

// Install: pre-cache static assets (NOT index.html — see fetch handler)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// Activate: delete every old cache so stale files are gone immediately
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   index.html  → network-first (always pick up new deployments)
//   shell files → cache-first   (fast, versioned by CACHE name)
//   everything else → network pass-through
self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Pass-through: Firebase, Google APIs, fonts
  if (
    url.includes('googleapis.com') ||
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase') ||
    url.includes('fonts.g') ||
    url.includes('gstatic.com')
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  // index.html — network-first so deploys are picked up immediately
  const parsedUrl = new URL(url);
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Cache the fresh copy for offline fallback
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Shell assets — cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
