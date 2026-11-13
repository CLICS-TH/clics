#!/usr/bin/env node
// Proves the public vm1 origin before the front ends are pointed at it (deploy/vm1/README.md, cutover
// step 2): /health/deep, the evaluator manifest against Railway's, CORS for both front-end origins, and,
// with --stream, that one chat turn arrives as separate server-sent events and not as one buffered body.
// Read-only unless --stream, which creates one PLE and spends one AI turn on SMOKE_PHYS_EMAIL/PW's account.
//   node scripts/deploy/cutover-check.mjs [--base URL] [--railway URL] [--stream]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { VM1_ORIGIN, RAILWAY_ORIGIN, apiOrigin } = createRequire(import.meta.url)('../lib/api-origin.cjs');

export const FRONT_END_ORIGINS = ['https://physician-ui.vercel.app', 'https://audit-dashboard-rouge.vercel.app'];

export function corsVerdict(origin, headers) {
  const got = headers.get('access-control-allow-origin');
  return { ok: got === origin, detail: `allow-origin=${got ?? 'none'}` };
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

// events: [{ at: ms since request, data: string }] for each SSE frame. A buffered response delivers every
// frame in one read, so all `at` values collapse together; a streamed one spreads over the reply.
export function streamVerdict(contentType, events, minSpreadMs = 300) {
  if (!/text\/event-stream/.test(contentType || '')) return { ok: false, detail: `content-type=${contentType || 'none'}` };
  if (events.length < 3) return { ok: false, detail: `only ${events.length} event(s)` };
  const spread = events[events.length - 1].at - events[0].at;
  return { ok: spread >= minSpreadMs, detail: `${events.length} events over ${Math.round(spread)} ms` };
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
  const base = apiOrigin(opt('--base', process.env.CUTOVER_BASE || VM1_ORIGIN));
  const railway = apiOrigin(opt('--railway', RAILWAY_ORIGIN));
  const rows = [];
  const row = (name, v) => { rows.push({ name, ...v }); console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${name}  ${v.detail}`); };

  const [vm1, rail] = await Promise.all([json(base + '/health/deep'), json(railway + '/health/deep')]);
  row('vm1 /health/deep', healthVerdict(vm1.body));
  row('evaluator manifest equals Railway', manifestVerdict(vm1.body, rail.body));
  for (const origin of FRONT_END_ORIGINS) {
    const r = await fetch(base + '/health', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    row(`CORS ${origin}`, corsVerdict(origin, r.headers));
  }
  if (args.includes('--stream')) row('streamed chat turn is not buffered', await streamedTurn(base));
  else console.log('skip  streamed chat turn (run with --stream; it spends one AI turn)');
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(2); });
