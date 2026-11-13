import test from 'node:test';
import assert from 'node:assert/strict';
import { corsVerdict, healthVerdict, manifestVerdict, streamVerdict } from './cutover-check.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { apiOrigin, VM1_ORIGIN } = createRequire(import.meta.url)('../lib/api-origin.cjs');

test('CORS must echo the exact origin, not a wildcard or nothing', () => {
  const o = 'https://physician-ui.vercel.app';
  assert.equal(corsVerdict(o, new Headers({ 'access-control-allow-origin': o })).ok, true);
  assert.equal(corsVerdict(o, new Headers({ 'access-control-allow-origin': '*' })).ok, false);
  assert.equal(corsVerdict(o, new Headers()).ok, false);
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

test('api origin: one default (vm1), env override, trailing slash stripped', () => {
  const saved = process.env.CLICS_API_ORIGIN;
  delete process.env.CLICS_API_ORIGIN;
  assert.equal(apiOrigin(), VM1_ORIGIN);
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

test('the Portal config points at the same origin the scripts default to', () => {
  const cfg = readFileSync(path.join(ROOT, 'physician-ui/public/js/config.js'), 'utf8');
  assert.ok(cfg.includes(`: '${VM1_ORIGIN}'`));
});
