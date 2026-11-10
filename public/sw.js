/* Farlight service worker.
 *  - Pages (index.html): network first, so a new deploy shows on the next reload. Cached copy when offline.
 *  - assets/ (hashed filenames): cache first, they never change.
 *  - maps/, icons, manifest (not hashed): cache first, refreshed in the background.
 * Bump VERSION to drop every old cache. No skipWaiting: a new worker takes over when the old
 * tabs close, so a running game never loses files it still needs. */
const VERSION = 'v1';
const CACHE = `farlight-${VERSION}`;
const MAX_HASHED = 80;

/** Which strategy a path (relative to the worker scope) gets. */
function strategy(rel) {
  if (rel === '' || rel === 'index.html') return 'page';
  if (rel.startsWith('assets/')) return 'hashed';
  if (/^maps\/.+\.bin$/.test(rel) || /^icon[^/]*$/.test(rel) || rel === 'manifest.webmanifest' || rel === 'favicon.svg' || rel === 'apple-touch-icon.png') return 'static';
  return null;
}

self.addEventListener('install', () => {});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('farlight-') && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function trim(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.includes('/assets/'));
  for (const r of keys.slice(0, Math.max(0, keys.length - MAX_HASHED))) await cache.delete(r);
}

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, refresh) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) {
    if (refresh) fetch(req).then((res) => (res.ok ? cache.put(req, res) : undefined)).catch(() => {});
    return hit;
  }
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    await trim(cache);
  }
  return res;
}

// The page lists what it already loaded, so the first visit works offline too.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'precache' || !Array.isArray(data.urls)) return;
  const scope = new URL(self.registration.scope);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const u of data.urls) {
        try {
          const url = new URL(u, scope);
          if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) continue;
          const kind = strategy(url.pathname.slice(scope.pathname.length));
          if (kind === null) continue;
          const key = kind === 'page' ? new URL('index.html', scope).href : url.href;
          if (await cache.match(key, { ignoreVary: true })) continue;
          const res = await fetch(url.href);
          if (res.ok) await cache.put(key, res);
        } catch (e) {
          /* skip what cannot be fetched */
        }
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const kind = strategy(url.pathname.slice(scope.length));
  if (kind === 'page') {
    // Every query string shares one cached page.
    event.respondWith(networkFirst(req, new URL('index.html', self.registration.scope).href));
  } else if (kind === 'hashed') {
    event.respondWith(cacheFirst(req, false));
  } else if (kind === 'static') {
    event.respondWith(cacheFirst(req, true));
  }
});
