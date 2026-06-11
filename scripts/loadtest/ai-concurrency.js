// CLICS — concurrent AI-chat test. Fires ~40 SIMULTANEOUS real Claude generations through guest mode
// (each /guest/message = 1 Claude call via RIMPL; guest writes ZERO DB rows). Measures how the AI path
// behaves under true concurrency: successes, errors (502 = RIMPL/Claude failure or rate-limit), latency.
// Hard budget cap. ~$0.065/call (observed lower, ~$0.045). User cap 2026-06-11: ≤ $2.
//   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/loadtest/ai-concurrency.js
const BASE = 'https://backend-production-c12e4.up.railway.app';
const CONCURRENCY = 28;          // simultaneous AI chats (= cap, so the fan-out is never pre-truncated)
const MAX_AI_CALLS = 28;         // hard budget cap: 28 × $0.065 = $1.82 < $2
const COST_PER_CALL = 0.065;
const REQ_TIMEOUT_MS = 95000;    // RIMPL chat timeout is 75s; allow headroom under load
const PROMPTS = [
  'A 58-year-old man has sudden chest pain at rest with diaphoresis. What is the single most dangerous diagnosis to exclude first, and why?',
  'A 24-year-old woman has migratory right-lower-quadrant pain and a low-grade fever. What is the first test you would order and what are you ruling out?',
  'A 67-year-old with diabetes and CKD has progressive exertional dyspnoea. How do you distinguish heart failure from PE at the bedside?',
  'A 72-year-old with COPD has fever, productive cough and new confusion. How do you risk-stratify severity?',
  'A 45-year-old has a thunderclap occipital headache peaking in seconds. What must you exclude and how?',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let aiCalls = 0;

async function pool(items, size, fn) { let i = 0; await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]) : 0; };

async function guestMessage(token, prompt) {
  if (aiCalls >= MAX_AI_CALLS) return { ok: false, status: 0, ms: 0, err: 'budget_cap' };
  aiCalls++;
  const t0 = process.hrtime.bigint();
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(BASE + '/guest/message', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ message: prompt, language: 'en', history: [] }), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const okContent = r.status === 200 && j && j.content && j.content.length > 0;
    return { ok: okContent, status: r.status, ms, tokens: j?.token_count ?? null, err: r.status !== 200 ? (j?.error || ('http_' + r.status)) : (okContent ? null : 'empty_content') };
  } catch (e) { const ms = Number(process.hrtime.bigint() - t0) / 1e6; return { ok: false, status: 0, ms, err: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(to); }
}

(async () => {
  console.log(`Concurrent AI-chat test → ${BASE}\nConcurrency: ${CONCURRENCY} simultaneous Claude generations · cap ${MAX_AI_CALLS} calls (~$${(MAX_AI_CALLS * COST_PER_CALL).toFixed(2)})\n`);

  // start guest sessions (free, no Claude)
  const tokens = [];
  await pool(Array.from({ length: CONCURRENCY }), 10, async () => {
    const r = await fetch(BASE + '/guest/start', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (j.token) tokens.push(j.token);
  });
  console.log(`Started ${tokens.length} guest sessions. Firing ${tokens.length} AI chats ALL AT ONCE...\n`);

  // fire all concurrently
  const results = [];
  const wall0 = process.hrtime.bigint();
  await Promise.all(tokens.map((tok, i) => guestMessage(tok, PROMPTS[i % PROMPTS.length]).then(r => results.push(r))));
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;

  const ok = results.filter(r => r.ok).length;
  const lat = results.filter(r => r.ok).map(r => r.ms);
  const errKinds = {};
  results.filter(r => !r.ok).forEach(r => { const k = (r.err || '').toString().slice(0, 40); errKinds[k] = (errKinds[k] || 0) + 1; });
  const toks = results.filter(r => r.tokens).map(r => r.tokens);
  const avgTok = toks.length ? Math.round(toks.reduce((a, b) => a + b, 0) / toks.length) : 0;

  console.log(`RESULTS (${results.length} concurrent AI chats, wall ${(wallMs / 1000).toFixed(1)}s):`);
  console.log(`  succeeded : ${ok}/${results.length} (${(ok / results.length * 100).toFixed(0)}%)`);
  console.log(`  errors    : ${results.length - ok} ${JSON.stringify(errKinds)}`);
  console.log(`  latency   : p50 ${pctl(lat, 50)}ms · p95 ${pctl(lat, 95)}ms · p99 ${pctl(lat, 99)}ms · max ${Math.round(Math.max(...lat, 0))}ms (successful calls)`);
  console.log(`  avg assistant tokens/turn: ${avgTok}`);
  console.log(`  Claude calls spent: ${aiCalls} ≈ $${(aiCalls * COST_PER_CALL).toFixed(2)} (cap $${(MAX_AI_CALLS * COST_PER_CALL).toFixed(2)})`);
  require('fs').writeFileSync('/tmp/ai-concurrency-results.json', JSON.stringify({ concurrency: tokens.length, ok, errors: results.length - ok, errKinds, wallMs, p50: pctl(lat, 50), p95: pctl(lat, 95), avgTok, aiCalls }, null, 2));
  console.log('\nWrote /tmp/ai-concurrency-results.json');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
