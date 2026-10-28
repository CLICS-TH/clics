// Booth Mode offline cache (#213), registered by js/booth-shell.js with scope /booth. There is no hand-kept
// precache list: the page posts { type: 'precache', urls } with everything it loaded plus the loop's files.
// Loop media is cache-first, so staff replacing a file give it a new name (README, "Booth loop files").
const CACHE = 'clics-booth-v1';
const NETWORK_TIMEOUT_MS = 4_000;
const LOOP_DIR = '/booth-loop/';
const MANIFEST = `${LOOP_DIR}manifest.json`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'precache' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(precache(event.data.urls));
});

async function precache(urls) {
  const cache = await caches.open(CACHE);
  for (const raw of urls) {
    let url;
    try { url = new URL(raw, self.location.origin); } catch { continue; }
    if (url.origin !== self.location.origin || await cache.match(url.href)) continue;
    // One missing file (the promo before it ships) must not stop the rest.
    await cache.add(url.href).catch(() => {});
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isMedia = url.pathname.startsWith(LOOP_DIR) && url.pathname !== MANIFEST;
  event.respondWith(isMedia ? cacheFirst(event, url) : networkFirst(event));
});

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

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((res) => {
    if (res.ok && res.status !== 206) event.waitUntil(cache.put(request.url, res.clone()).catch(() => {}));
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
