import test from 'node:test';
import assert from 'node:assert/strict';
import { pageVerdict, auditRedirectVerdict, healthVerdict, manifestVerdict, streamVerdict } from './cutover-check.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { apiOrigin, VM1_API_BASE, SITE_ORIGIN } = createRequire(import.meta.url)('../lib/api-origin.cjs');

test('a front-end page passes only as a 200 HTML page', () => {
  assert.equal(pageVerdict(200, 'text/html; charset=utf-8').ok, true);
  assert.equal(pageVerdict(404, 'text/html').ok, false);
  assert.equal(pageVerdict(200, 'application/json').ok, false, 'the backend answering a page path is a failure');
  assert.equal(pageVerdict(502, null).ok, false);
});

test('a bare /audit must redirect to the base path', () => {
  assert.equal(auditRedirectVerdict(301, 'https://clics.ccme.or.th/audit/').ok, true);
  assert.equal(auditRedirectVerdict(301, '/audit/').ok, true);
  assert.equal(auditRedirectVerdict(404, null).ok, false);
  assert.equal(auditRedirectVerdict(301, '/login').ok, false);
});

test('health: rimpl serving as the public origin is a failure', () => {
  const up = { service: 'backend', checks: { rimpl: { status: 'up' }, supabase: { status: 'up' } } };
  assert.equal(healthVerdict(up).ok, true);
  assert.equal(healthVerdict({ ...up, service: 'rimpl' }).ok, false);
  assert.equal(healthVerdict({ ...up, checks: { ...up.checks, rimpl: { status: 'down' } } }).ok, false);
  assert.equal(healthVerdict(null).ok, false);
});

test('manifest: equal digests pass, a missing digest on either side fails', () => {
  const m = (s) => ({ checks: { rimpl: { deep: { manifest: { sha256: s } } } } });
  assert.equal(manifestVerdict(m('aa'), m('aa')).ok, true);
  assert.equal(manifestVerdict(m('aa'), m('bb')).ok, false);
  assert.equal(manifestVerdict(m(undefined), m(undefined)).ok, false);
});

test('stream: buffered or errored turns fail, an even spread passes', () => {
  const ES = 'text/event-stream';
  const frames = (ats) => ats.map((at) => ({ at, data: 'event: delta\ndata: {"t":"x"}' }));
  assert.equal(streamVerdict(ES, frames([1200, 1201, 1202, 1203])).ok, false);
  assert.equal(streamVerdict(ES, frames([800, 1000, 1400, 2100])).ok, true);
  assert.equal(streamVerdict('application/json', frames([0, 500, 900])).ok, false);
  assert.equal(streamVerdict(ES, frames([0, 900])).ok, false);
  const even = frames(Array.from({ length: 50 }, (_, i) => (i * 5000) / 49));
  assert.equal(streamVerdict(ES, even).ok, true);
  const bursts = [];
  for (const t of [0, 1500, 3000, 4500]) for (let i = 0; i < 150; i++) bursts.push({ at: t, data: 'd' });
  assert.equal(streamVerdict(ES, bursts).ok, false, '4 bursts of 150 frames are chunk-buffered delivery');
  const errored = [
    { at: 0, data: 'event: status\ndata: {"phase":"thinking"}' },
    { at: 200, data: 'event: delta\ndata: {"t":"x"}' },
    { at: 400, data: 'event: done\ndata: {"status":502,"body":{"error":"x"}}' },
  ];
  assert.equal(streamVerdict(ES, errored).ok, false, 'a done frame with an error status fails');
  errored[2].data = 'event: done\ndata: {"status":200,"body":{}}';
  assert.equal(streamVerdict(ES, errored).ok, true);
});

test('api origin: one default (vm1, under /api), env override, trailing slash stripped', () => {
  const saved = process.env.CLICS_API_ORIGIN;
  delete process.env.CLICS_API_ORIGIN;
  assert.equal(apiOrigin(), VM1_API_BASE);
  assert.equal(VM1_API_BASE, `${SITE_ORIGIN}/api`);
  assert.equal(apiOrigin('https://x.test/'), 'https://x.test');
  process.env.CLICS_API_ORIGIN = 'https://y.test';
  assert.equal(apiOrigin(), 'https://y.test');
  assert.equal(apiOrigin('https://own.test'), 'https://own.test');
  if (saved === undefined) delete process.env.CLICS_API_ORIGIN; else process.env.CLICS_API_ORIGIN = saved;
});

test('no script outside lib hard-codes the Railway origin', () => {
  const hits = execFileSync('grep', ['-rln', 'backend-production-c12e4', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(hits.filter((f) => !['scripts/lib/api-origin.cjs', 'scripts/smoke/local-ai-sandbox-smoke.mjs', 'scripts/deploy/cutover-check.test.mjs'].includes(f)), []);
});

// The Portal calls /api on whatever origin served it, so on vm1 that is the base the scripts default to.
test('the Portal config calls the API at /api on its own origin, as the scripts do on vm1', () => {
  const cfg = readFileSync(path.join(ROOT, 'physician-ui/public/js/config.js'), 'utf8');
  assert.ok(cfg.includes(`: location.origin + '/api';`), 'config.js builds the API URL from its own origin');
  assert.equal(new URL(VM1_API_BASE).pathname, '/api');
  assert.ok(!cfg.includes('clics.ccme.or.th'), 'config.js names no host, so a renamed origin needs no edit');
});

// The two Vercel projects become redirects to the one origin. The Portal's paths and query strings carry over 1:1
// (an invite link is /invite.html?token=<invite>, and must still work). The dashboard's go under /audit, and its
// ?token= is blanked: Vercel carries the query over unless the destination names the key, and that token was a
// session (#182), which never travels to the new origin in a URL.
test('the Vercel projects redirect to the one origin, the dashboard never carrying a ?token=', () => {
  const redirects = (dir) => JSON.parse(readFileSync(path.join(ROOT, dir, 'vercel.json'), 'utf8')).redirects;
  assert.deepEqual(redirects('physician-ui'), [{ source: '/:path*', destination: `${SITE_ORIGIN}/:path*`, permanent: false }]);
  assert.deepEqual(redirects('audit-dashboard'), [
    { source: '/:path*', has: [{ type: 'query', key: 'token' }], destination: `${SITE_ORIGIN}/audit/:path*?token=`, permanent: false },
    { source: '/:path*', destination: `${SITE_ORIGIN}/audit/:path*`, permanent: false },
  ]);
});
