// Baal Shravan — Service Worker
// Caches the app shell so it loads instantly and works offline.
// Audio streams from Google Drive are never cached (too large).

const CACHE = 'baal-shravan-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/firebase-config.js',
  '/config.js',
  '/baal.png',
];

// Install: pre-cache the app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve shell from cache, everything else from network
self.addEventListener('fetch', (e) => {
  // Never cache Google Drive, Firebase, or font requests
  const url = e.request.url;
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

  // App shell: cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
