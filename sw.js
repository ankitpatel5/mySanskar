// Sanskar — Service Worker
// Caches the app shell so it loads instantly and works offline.
// Audio streams from Google Drive are never cached (too large).
//
// VERSIONING: bump CACHE whenever you deploy new app files so that
// home-screen users get the update on their next visit.

const CACHE = 'sanskar-v16';

// Static assets — cache-first (safe: only change when CACHE is bumped)
const SHELL = [
  '/styles.css',
  '/app.js',
  '/stories-data.js',
  '/translations-data.js',
  '/title-translations.js',
  '/firebase-config.js',
  '/conversation-starters.js',
  '/baal.png',
];

// Install: fetch every shell file fresh from the network (bypass HTTP cache)
// so a CACHE bump always picks up the latest bytes, even within max-age windows.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        SHELL.map((url) =>
          fetch(url, { cache: 'no-store' }).then((res) => {
            if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
            return c.put(url, res);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate: delete every old cache so stale files are gone immediately,
// then tell all open tabs to reload so they get the fresh shell at once.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => {
        // Reload every open tab so the new shell (CSS/JS) takes effect immediately
        // without the user needing to close and reopen the app.
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
      })
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
