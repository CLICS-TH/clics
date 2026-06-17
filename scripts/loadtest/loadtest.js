// CLICS load / concurrency test — goal: prove the app sustains >100 concurrent users.
// Dependency-free (Node 18+ global fetch). Runs against the live backend.
//
//   node scripts/loadtest/loadtest.js
//
// Budget: only Phase D spends Claude tokens; it is hard-capped at MAX_AI_CALLS guest turns
// (~$0.03-0.05 each) so total Claude spend stays well under $1. Phases A-C are free read/auth.
// Phase D uses GUEST mode (hits Claude, writes ZERO DB rows — no data pollution).

const BASE = process.env.CLICS_BASE || 'https://backend-production-c12e4.up.railway.app';
const PW_R2 = { sa: 'ClicsSuper#2026r2', ad: 'ClicsAdmin#2026r2' };
const SOAK = 'SoakPass#2026';
const LEVELS = [50, 100, 150, 200];      // concurrency levels to sweep
const REQS_PER_LEVEL = c => c * 3;        // total requests fired at each level
const MAX_AI_CALLS = 12;                  // hard budget cap for Phase D (Claude)
const REQ_TIMEOUT_MS = 30000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let aiCalls = 0; // global Claude-call counter (Phase D budget guard)

// timed request → { ok, status, ms, err }
async function timed(path, { method = 'GET', token, body } = {}) {
  const t0 = process.hrtime.bigint();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    // drain body so the socket frees
    await res.text().catch(() => {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms };
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ok: false, status: 0, ms, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(to);
  }
}

// run `total` tasks with at most `concurrency` in flight; collect results
async function runLevel(total, concurrency, taskFn) {
  const results = [];
  let next = 0;
  const wall0 = process.hrtime.bigint();
  const worker = async () => {
    while (next < total) { const i = next++; results.push(await taskFn(i)); }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  return summarize(results, wallMs, concurrency);
}

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : 0; }
function summarize(results, wallMs, concurrency) {
  const lat = results.map(r => r.ms).sort((a, b) => a - b);
  const ok = results.filter(r => r.ok).length;
  const errors = results.length - ok;
  const errKinds = {};
  results.filter(r => !r.ok).forEach(r => { const k = r.err || ('http_' + r.status); errKinds[k] = (errKinds[k] || 0) + 1; });
  return {
    concurrency, requests: results.length, ok, errors,
    errorRate: +(errors / results.length * 100).toFixed(2),
    throughput_rps: +(results.length / (wallMs / 1000)).toFixed(1),
    p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(lat[lat.length - 1] || 0),
    errKinds,
  };
}

const login = async (email, password) => {
  const res = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (await res.json().catch(() => ({}))).access_token;
};

function printRow(label, s) {
  console.log(`  c=${String(s.concurrency).padStart(3)} | ${String(s.requests).padStart(4)} req | ok ${String(s.ok).padStart(4)} | err ${String(s.errors).padStart(3)} (${s.errorRate}%) | ${String(s.throughput_rps).padStart(6)} rps | p50 ${String(s.p50).padStart(4)}ms p95 ${String(s.p95).padStart(5)}ms p99 ${String(s.p99).padStart(5)}ms max ${s.max}ms${Object.keys(s.errKinds).length ? '  ' + JSON.stringify(s.errKinds) : ''}`);
}

(async () => {
  const out = { base: BASE, started: new Date().toISOString(), phases: {} };
  console.log(`CLICS load test → ${BASE}\nLevels: ${LEVELS.join(', ')} concurrent · AI budget cap: ${MAX_AI_CALLS} guest turns\n`);

  // ---- tokens for authed phases ----
  const tokens = {};
  tokens.sa = await login('superadmin@clics.th', PW_R2.sa);
  tokens.ad = await login('admin@clics.th', PW_R2.ad);
  tokens.au = await login('soakaud1@example.com', SOAK);
  tokens.ph = await login('soakdoc09@example.com', SOAK);
  console.log('tokens:', Object.entries(tokens).map(([k, v]) => `${k}:${v ? 'ok' : 'FAIL'}`).join(' '), '\n');

  // ===== Phase A — raw HTTP ceiling (GET /health, no auth, no DB) =====
  console.log('PHASE A — raw HTTP ceiling: GET /health (no auth, no DB)');
  out.phases.A = [];
  for (const c of LEVELS) { const s = await runLevel(REQS_PER_LEVEL(c), c, () => timed('/health')); out.phases.A.push(s); printRow('A', s); await sleep(800); }

  // ===== Phase B — realistic authed reads (DB-backed; the Supabase-pool ceiling) =====
  console.log('\nPHASE B — realistic authed reads (mixed, DB-backed)');
  const reads = [
    { token: tokens.sa, path: '/auth/me' }, { token: tokens.sa, path: '/admin/users' },
    { token: tokens.sa, path: '/admin/slots' }, { token: tokens.sa, path: '/admin/cles' },
    { token: tokens.ad, path: '/admin/cles/flagged' }, { token: tokens.ad, path: '/admin/auditors' },
    { token: tokens.au, path: '/auditor/queue' },
    { token: tokens.ph, path: '/cles' }, { token: tokens.ph, path: '/cles/lpdp/me' },
  ];
  out.phases.B = [];
  for (const c of LEVELS) { const s = await runLevel(REQS_PER_LEVEL(c), c, i => { const r = reads[i % reads.length]; return timed(r.path, { token: r.token }); }); out.phases.B.push(s); printRow('B', s); await sleep(1000); }

  // ===== Phase C — login burst (Supabase auth) =====
  console.log('\nPHASE C — login burst: POST /auth/login');
  const creds = [['superadmin@clics.th', PW_R2.sa], ['admin@clics.th', PW_R2.ad], ['soakaud1@example.com', SOAK], ['soakdoc09@example.com', SOAK]];
  out.phases.C = [];
  for (const c of [50, 100]) { const s = await runLevel(c * 2, c, i => { const [e, p] = creds[i % creds.length]; return timed('/auth/login', { method: 'POST', body: { email: e, password: p } }); }); out.phases.C.push(s); printRow('C', s); await sleep(1000); }

  // ===== Phase D — AI-path concurrency via GUEST (budget-capped) =====
  console.log(`\nPHASE D — AI concurrency via guest mode (cap ${MAX_AI_CALLS} Claude turns, ~$0.5 max)`);
  const N_AI = Math.min(10, MAX_AI_CALLS);
  // start N guest sessions first (free), then fire their first message concurrently (the Claude burst)
  const sessions = [];
  for (let i = 0; i < N_AI; i++) {
    const r = await fetch(BASE + '/guest/start', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (j.token) sessions.push(j.token);
  }
  console.log(`  started ${sessions.length} guest sessions`);
  const aiTask = async (i) => {
    if (aiCalls >= MAX_AI_CALLS) return { ok: false, status: 0, ms: 0, err: 'budget_cap' };
    aiCalls++;
    return timed('/guest/message', { method: 'POST', token: sessions[i], body: { message: 'A 58-year-old with chest pain — what is the most dangerous diagnosis to rule out first?', language: 'en', history: [] } });
  };
  const sD = await runLevel(sessions.length, sessions.length, aiTask); // all concurrent
  out.phases.D = [sD];
  printRow('D', sD);
  console.log(`  Claude turns spent: ${aiCalls} (≈ $${(aiCalls * 0.045).toFixed(2)}, cap $${(MAX_AI_CALLS * 0.045).toFixed(2)})`);

  out.finished = new Date().toISOString();
  out.ai_calls = aiCalls;
  require('fs').writeFileSync('/tmp/loadtest-results.json', JSON.stringify(out, null, 2));
  console.log('\nWrote /tmp/loadtest-results.json');

  // verdict
  const maxClean = (phase) => { let best = 0; for (const s of out.phases[phase]) if (s.errorRate < 1) best = Math.max(best, s.concurrency); return best; };
  console.log(`\nVERDICT  A(health) clean ≤ ${maxClean('A')} · B(authed reads) clean ≤ ${maxClean('B')} · C(login) clean ≤ ${maxClean('C')} concurrent (errorRate <1%).`);
  process.exit(0);
})().catch(e => { console.error('LOADTEST FAILED:', e.message); process.exit(1); });
