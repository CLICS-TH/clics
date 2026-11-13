// CLICS — DISTINCT-user concurrency test. Unlike the request-flood (reused tokens), this provisions
// many distinct accounts, logs each in (its own token), then fires concurrent reads where every
// in-flight request belongs to a DIFFERENT user — a faithful "N users using the app at once".
// Read-only → $0 Claude. Creates loadtest-* accounts via the service-role and DELETES them at the end.
//   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/loadtest/loadtest-distinct.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = require('../lib/api-origin.cjs').apiOrigin();
const N = 120;                 // accounts to provision (aim to clear 100 distinct tokens)
const PW = 'LoadTest#2026';
const DOMAIN = 'clics.test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pool(items, size, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function timed(path, token) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
    await res.text().catch(() => {});
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (e) { return { ok: false, status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, err: e.message }; }
}
const pctl = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]) : 0; };

(async () => {
  console.log(`DISTINCT-user concurrency test → ${BASE}\nProvisioning ${N} accounts...`);

  // --- 1. provision N distinct physician accounts directly (service-role; bypasses API rate limits) ---
  const emails = Array.from({ length: N }, (_, i) => `loadtest-${String(i + 1).padStart(3, '0')}@${DOMAIN}`);
  let created = 0;
  await pool(emails, 10, async (email) => {
    const { data, error } = await s.auth.admin.createUser({ email, password: PW, email_confirm: true });
    if (error || !data?.user) return;
    const { error: pErr } = await s.from('professionals').insert({ id: data.user.id, role: 'physician', full_name_th: 'โหลดเทสต์', full_name_en: 'Load Test', status: 'active' });
    if (!pErr) created++;
  });
  console.log(`  created ${created}/${N} accounts`);

  // --- 2. obtain distinct tokens via the real /auth/login, STAGGERED to respect the auth rate-limit ---
  console.log('Logging in (staggered, with backoff) to collect distinct tokens...');
  await sleep(5000);
  const tokens = [];
  const queue = [...emails];
  let round = 0;
  while (queue.length && round < 30) {
    round++;
    const batch = queue.splice(0, 8);
    const res = await pool(batch, 8, async (email) => {
      const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
      const j = await r.json().catch(() => ({}));
      return j.access_token ? { token: j.access_token } : { retry: email, status: r.status };
    });
    res.forEach(x => { if (x.token) tokens.push(x.token); else if (x.retry && round < 28) queue.push(x.retry); });
    if (tokens.length % 24 === 0 || !queue.length) console.log(`  tokens so far: ${tokens.length} (queue ${queue.length})`);
    await sleep(1400);
  }
  console.log(`  obtained ${tokens.length} distinct tokens`);

  // --- 3. distinct-user concurrency: fire reads where each in-flight request uses a DIFFERENT token ---
  const results = {};
  for (const conc of [50, 100, tokens.length].filter((v, i, a) => v <= tokens.length && a.indexOf(v) === i)) {
    const reqs = [];
    const rounds = 3;
    for (let r = 0; r < rounds; r++) for (let u = 0; u < conc; u++) reqs.push(tokens[u]); // each user hits the app `rounds` times
    const lat = [], errs = {}; let ok = 0;
    let next = 0; const wall0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: conc }, async () => {
      while (next < reqs.length) { const idx = next++; const res = await timed(idx % 2 ? '/auth/me' : '/ples', reqs[idx]); lat.push(res.ms); if (res.ok) ok++; else { const k = res.err || 'http_' + res.status; errs[k] = (errs[k] || 0) + 1; } }
    }));
    const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
    const summary = { distinct_users: conc, requests: reqs.length, ok, errors: reqs.length - ok, errorRate: +((reqs.length - ok) / reqs.length * 100).toFixed(2), rps: +(reqs.length / (wallMs / 1000)).toFixed(1), p50: pctl(lat, 50), p95: pctl(lat, 95), p99: pctl(lat, 99), errs };
    results[conc] = summary;
    console.log(`  ${String(conc).padStart(3)} distinct users | ${summary.requests} req | ok ${summary.ok} | err ${summary.errors} (${summary.errorRate}%) | ${summary.rps} rps | p50 ${summary.p50}ms p95 ${summary.p95}ms${Object.keys(errs).length ? ' ' + JSON.stringify(errs) : ''}`);
    await sleep(1000);
  }

  // --- 4. cleanup: delete every loadtest account (service-role; cascades professionals) ---
  console.log('Cleaning up load-test accounts...');
  let deleted = 0;
  for (let page = 1; ; page++) {
    const { data } = await s.auth.admin.listUsers({ page, perPage: 1000 });
    const lt = data.users.filter(u => u.email?.startsWith('loadtest-') && u.email.endsWith('@' + DOMAIN));
    for (const u of lt) { await s.auth.admin.deleteUser(u.id); deleted++; }
    if (data.users.length < 1000) break;
  }
  const { count: physLeft } = await s.from('professionals').select('id', { count: 'exact', head: true }).eq('role', 'physician');
  console.log(`  deleted ${deleted} load-test accounts · physicians remaining: ${physLeft}`);

  require('fs').writeFileSync('/tmp/loadtest-distinct-results.json', JSON.stringify({ created, tokens: tokens.length, results }, null, 2));
  console.log(`\nDISTINCT-user result: obtained ${tokens.length} tokens; concurrency tested up to ${tokens.length} distinct users.`);
  console.log('Claude spend: $0 (read-only test).');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
