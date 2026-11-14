// Booth Mode offline cache (#213), registered by js/booth-shell.js with scope /booth. There is no hand-kept
// precache list: the page posts { type: 'precache', urls } with everything it loaded plus the loop's files.
// Loop media is cache-first. Each time the manifest comes from the network, every cached loop file is revalidated
// (a file replaced under the same name is fetched again) and files the manifest no longer lists are dropped.
// The page also posts { type: 'case', id, kase } after a play starts, and the case is kept offline at
// /booth-case/<id>.json, one entry per case played. The event's pool is a handful of cases, so nothing is evicted.
const CACHE = 'clics-booth-v1';
const NETWORK_TIMEOUT_MS = 4_000;
const LOOP_DIR = '/booth-loop/';
const MANIFEST = `${LOOP_DIR}manifest.json`;
const ID = '[a-z0-9][a-z0-9-]{0,31}';
const CASE_ID = new RegExp(`^${ID}$`);
const CASE_PATH = new RegExp(`^/booth-case/${ID}\\.json$`);
const LEGACY_CASE_KEY = '/booth-case.json';
// The backend on the Portal's own origin (vm1, #429). Its answers are live state (is the booth open, the board),
// so they are never cached or served from the cache: offline must reach the page as a failed fetch.
const API_PREFIX = '/api/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  // The single-case entry of the build before the pool: no page asks for it any more.
  await (await caches.open(CACHE)).delete(LEGACY_CASE_KEY);
  await self.clients.claim();
})()));

self.addEventListener('message', (event) => {
  const { type, id, kase, urls } = event.data ?? {};
  if (type === 'precache' && Array.isArray(urls)) event.waitUntil(precache(urls));
  if (type === 'case' && typeof id === 'string' && CASE_ID.test(id) && kase && typeof kase === 'object') event.waitUntil(keepCase(id, kase));
});

async function keepCase(id, kase) {
  const cache = await caches.open(CACHE);
  await cache.put(`/booth-case/${id}.json`, new Response(JSON.stringify(kase), { headers: { 'Content-Type': 'application/json' } }));
}

async function precache(urls) {
  const cache = await caches.open(CACHE);
  for (const raw of urls) {
    let url;
    try { url = new URL(raw, self.location.origin); } catch { continue; }
    if (url.origin !== self.location.origin || url.pathname.startsWith(API_PREFIX) || await cache.match(url.href)) continue;
    // One missing file (the promo before it ships) must not stop the rest.
    await cache.add(url.href).catch(() => {});
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith(API_PREFIX)) return;
  if (CASE_PATH.test(url.pathname)) {
    event.respondWith(caches.open(CACHE).then((c) => c.match(url.pathname)).then((hit) => hit ?? new Response(null, { status: 404 })));
    return;
  }
  const isMedia = url.pathname.startsWith(LOOP_DIR) && url.pathname !== MANIFEST;
  event.respondWith(isMedia ? cacheFirst(event, url) : networkFirst(event, url.pathname === MANIFEST ? refreshLoop : null));
});

let refreshing = null;
/** One pass at a time: drop cached loop files the manifest no longer lists, revalidate the rest. */
function refreshLoop(manifest) {
  refreshing ??= (async () => {
    const items = (await manifest.json())?.items;
    if (!Array.isArray(items)) return;
    const listed = new Set();
    for (const item of items) {
      if (typeof item?.src !== 'string') continue;
      try { listed.add(new URL(item?.src, self.location.origin).pathname); } catch { /* parseItem warns on the page */ }
    }
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) {
      const { pathname } = new URL(req.url);
      if (!pathname.startsWith(LOOP_DIR) || pathname === MANIFEST) continue;
      if (!listed.has(pathname)) await cache.delete(req);
      else await revalidate(cache, req);
    }
  })().catch(() => {}).finally(() => { refreshing = null; });
  return refreshing;
}

/** A conditional GET: 304 keeps the cached file, a 200 (the file was replaced under its name) replaces it. */
async function revalidate(cache, req) {
  const hit = await cache.match(req);
  const headers = {};
  const etag = hit?.headers.get('ETag');
  const modified = hit?.headers.get('Last-Modified');
  if (etag) headers['If-None-Match'] = etag;
  if (modified) headers['If-Modified-Since'] = modified;
  const res = await fetch(req.url, { cache: 'no-store', headers }).catch(() => null);
  if (res?.status === 200) await cache.put(req.url, res);
}

async function cacheFirst(event, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url.href, { ignoreSearch: true });
  if (!hit) {
    // The page's request may be a Range request, whose 206 can't be cached; fetch the whole file alongside.
    event.waitUntil(cache.add(url.href).catch(() => {}));
    return fetch(event.request);
  }
  const range = event.request.headers.get('range');
  return range ? sliceRange(hit, range) : hit;
}

async function sliceRange(hit, header) {
  const blob = await hit.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  let start = NaN;
  let end = size - 1;
  if (m && m[1] !== '') {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== '') {
    start = Math.max(size - Number(m[2]), 0);
  }
  if (!(start >= 0 && start < size && start <= end)) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

/** @param {((res: Response) => Promise<void>) | null} onFresh runs on a copy of each OK network answer */
async function networkFirst(event, onFresh) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((res) => {
    if (res.ok && res.status !== 206) {
      event.waitUntil(cache.put(request.url, res.clone()).catch(() => {}));
      if (onFresh) event.waitUntil(onFresh(res.clone()));
    }
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, null); });
  const res = await Promise.race([network.catch(() => null), timeout]);
  clearTimeout(timer);
  // Nothing cached yet (a file a newer deploy added): a slow answer beats a blank kiosk.
  return res ?? (await cache.match(request.url, { ignoreSearch: true })) ?? network.catch(() => Response.error());
}
