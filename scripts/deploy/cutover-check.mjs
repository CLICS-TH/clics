#!/usr/bin/env node
// Proves the public vm1 origin before the Vercel front ends redirect to it (deploy/vm1/README.md, cutover):
// the backend's /health/deep under /api, the evaluator manifest against Railway's, the Portal and the
// dashboard served from the same origin, and, with --stream, that one chat turn arrives as separate
// server-sent events and not as one buffered body. No CORS row: the front ends call /api on their own origin.
// Read-only unless --stream, which creates one PLE and spends one AI turn on SMOKE_PHYS_EMAIL/PW's account.
//   node scripts/deploy/cutover-check.mjs [--site URL] [--base URL] [--railway URL] [--stream]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { SITE_ORIGIN, VM1_API_BASE, RAILWAY_ORIGIN, apiOrigin } = createRequire(import.meta.url)('../lib/api-origin.cjs');

// The pages a signed-out visitor reaches first, each from its own server: the Portal's sign-in, and the
// dashboard's under its base path (a 200 there means the /audit/ location reaches Next, not the Portal).
export const SITE_PAGES = [['Portal /login', '/login'], ['dashboard /audit/login', '/audit/login']];

export function pageVerdict(status, contentType) {
  return { ok: status === 200 && /text\/html/.test(contentType || ''), detail: `HTTP ${status} ${contentType || 'no content-type'}` };
}

// A bare /audit must land on the dashboard's base path, not on the Portal's 404.
export function auditRedirectVerdict(status, location) {
  return { ok: [301, 308].includes(status) && /\/audit\/$/.test(location || ''), detail: `HTTP ${status} location=${location ?? 'none'}` };
}

export function healthVerdict(body) {
  const rimpl = body?.checks?.rimpl?.status;
  const supabase = body?.checks?.supabase?.status;
  const ok = body?.service === 'backend' && rimpl === 'up' && supabase === 'up';
  return { ok, detail: `service=${body?.service} rimpl=${rimpl} supabase=${supabase}` };
}

export function manifestVerdict(vm1, railway) {
  const a = vm1?.checks?.rimpl?.deep?.manifest?.sha256;
  const b = railway?.checks?.rimpl?.deep?.manifest?.sha256;
  return { ok: !!a && a === b, detail: `vm1=${a ?? 'none'} railway=${b ?? 'none'}` };
}

// events: [{ at: ms since request, data: frame text }] for each SSE frame. A buffered proxy delivers frames
// in bursts (one flush, many frames), however long the reply took overall, so first-to-last spread alone
// proves nothing. A frame counts as "bunched" when more than BUNCH_MAX frames share its 100 ms bucket.
// The turn passes only when under half the frames are bunched, the reply spans MIN_SPREAD_MS, and the
// closing `done` frame (when there is one) does not carry an error status.
const BUCKET_MS = 100;
const BUNCH_MAX = 8;
const MIN_SPREAD_MS = 300;

function doneStatus(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const frame = String(events[i].data);
    if (!/^event:\s*done\b/m.test(frame)) continue;
    const m = frame.match(/^data:\s*(.*)$/m);
    try { return Number(JSON.parse(m?.[1] ?? '').status); } catch { return NaN; }
  }
  return null;
}

export function streamVerdict(contentType, events) {
  if (!/text\/event-stream/.test(contentType || '')) return { ok: false, detail: `content-type=${contentType || 'none'}` };
  if (events.length < 3) return { ok: false, detail: `only ${events.length} event(s)` };
  const status = doneStatus(events);
  if (status !== null && !(status >= 200 && status < 400)) return { ok: false, detail: `done frame status=${status}` };
  const spread = events[events.length - 1].at - events[0].at;
  const buckets = new Map();
  for (const e of events) { const k = Math.floor(e.at / BUCKET_MS); buckets.set(k, (buckets.get(k) || 0) + 1); }
  let bunched = 0;
  for (const n of buckets.values()) if (n > BUNCH_MAX) bunched += n;
  const share = bunched / events.length;
  return {
    ok: spread >= MIN_SPREAD_MS && share < 0.5,
    detail: `${events.length} events over ${Math.round(spread)} ms, ${Math.round(share * 100)}% arrived in bursts`,
  };
}

async function json(url, init) {
  const r = await fetch(url, init);
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}

async function streamedTurn(base) {
  const email = process.env.SMOKE_PHYS_EMAIL, password = process.env.SMOKE_PHYS_PW;
  if (!email || !password) return { ok: false, detail: 'set SMOKE_PHYS_EMAIL and SMOKE_PHYS_PW' };
  const post = (p, body, token) => fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const login = await (await post('/auth/login', { email, password })).json().catch(() => ({}));
  if (!login.access_token) return { ok: false, detail: 'login failed' };
  const ple = await (await post('/ples', { chief_complaint: 'exertional chest pain (hypothetical, de-identified)' }, login.access_token)).json().catch(() => ({}));
  if (!ple.id) return { ok: false, detail: 'POST /ples failed' };
  const t0 = performance.now();
  const res = await post(`/ples/${ple.id}/message`, { message: 'Hypothetical case: what is the first test you would order, and why?', language: 'en', stream: true }, login.access_token);
  const events = [];
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    const frames = pending.split('\n\n');
    pending = frames.pop();
    for (const f of frames) if (f.trim()) events.push({ at: performance.now() - t0, data: f });
  }
  return streamVerdict(res.headers.get('content-type'), events);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const site = String(opt('--site', SITE_ORIGIN)).replace(/\/+$/, '');
  const base = apiOrigin(opt('--base', process.env.CUTOVER_BASE || VM1_API_BASE));
  const railway = apiOrigin(opt('--railway', RAILWAY_ORIGIN));
  const rows = [];
  const row = (name, v) => { rows.push({ name, ...v }); console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${name}  ${v.detail}`); };

  const [vm1, rail] = await Promise.all([json(base + '/health/deep'), json(railway + '/health/deep')]);
  row('vm1 /health/deep', healthVerdict(vm1.body));
  row('evaluator manifest equals Railway', manifestVerdict(vm1.body, rail.body));
  for (const [name, p] of SITE_PAGES) {
    const r = await fetch(site + p);
    row(name, pageVerdict(r.status, r.headers.get('content-type')));
  }
  const bare = await fetch(`${site}/audit`, { redirect: 'manual' });
  row('bare /audit redirects to /audit/', auditRedirectVerdict(bare.status, bare.headers.get('location')));
  if (args.includes('--stream')) row('streamed chat turn is not buffered', await streamedTurn(base));
  else console.log('skip  streamed chat turn (run with --stream; it spends one AI turn)');
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(2); });
