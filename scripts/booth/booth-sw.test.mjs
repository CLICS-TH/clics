// booth-sw.js on one origin (#487): the booth API at /api/ is the page's own origin on vm1 (#429), and its answers
// (is the booth open, the board) must never be cached or answered from the cache, or an offline kiosk reads as open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const ORIGIN = 'https://clics.example.test';
const source = await readFile(new URL('../../physician-ui/public/booth-sw.js', import.meta.url), 'utf8');

function worker() {
  const listeners = {};
  const added = [];
  const cache = { add: async (u) => { added.push(u); }, match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => {} };
  const self = { location: { origin: ORIGIN }, addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } };
  vm.runInNewContext(source, { self, caches: { open: async () => cache, keys: async () => [] }, fetch: async () => new Response('net'), Response, URL, setTimeout, clearTimeout, Promise });
  return { listeners, added };
}

function fetchEvent(url) {
  const event = { request: { method: 'GET', url, headers: new Headers() }, responded: false, waits: [] };
  event.respondWith = () => { event.responded = true; };
  event.waitUntil = (p) => event.waits.push(p);
  return event;
}

test('booth API GETs on the page origin go to the network untouched', () => {
  const { listeners } = worker();
  for (const path of ['/api/booth/status', '/api/booth/board']) {
    const e = fetchEvent(ORIGIN + path);
    listeners.fetch(e);
    assert.equal(e.responded, false, `${path} must not be answered by the worker`);
  }
});

test('the booth page and its files are still served through the worker', () => {
  const { listeners } = worker();
  for (const path of ['/booth', '/js/booth-shell.js', '/booth-loop/manifest.json']) {
    const e = fetchEvent(ORIGIN + path);
    listeners.fetch(e);
    assert.equal(e.responded, true, `${path} goes through the worker's cache`);
  }
});

test('precache skips booth API URLs the page loaded', async () => {
  const { listeners, added } = worker();
  const e = { data: { type: 'precache', urls: ['/booth', '/api/booth/status', `${ORIGIN}/api/booth/board`, '/js/booth-shell.js'] }, waits: [] };
  e.waitUntil = (p) => e.waits.push(p);
  listeners.message(e);
  await Promise.all(e.waits);
  assert.deepEqual(added, [`${ORIGIN}/booth`, `${ORIGIN}/js/booth-shell.js`]);
});
