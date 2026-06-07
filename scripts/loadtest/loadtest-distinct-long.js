// CLICS — LONG distinct-user concurrency test. Goal: clear >=100 DISTINCT logged-in users at once.
// The only wall is Supabase's per-IP auth rate-limit, so we collect tokens PATIENTLY (sequential,
// adaptive backoff that lets the limiter refill) until we have >=TARGET, then fire them all at once.
// Supabase access tokens last ~1h, so tokens minted over ~20 min are all still valid at burst time.
// Read-only → $0 Claude. Provisions loadtest-* accounts (service-role) and DELETES them at the end.
//   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/loadtest/loadtest-distinct-long.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = 'https://backend-production-c12e4.up.railway.app';
const N = 130;               // accounts to provision
const TARGET = 110;          // distinct tokens we want (>100)
const DOMAIN = 'clics.test';
const PW = 'LoadTest#2026';
const MAX_LOGIN_MS = 26 * 60 * 1000; // hard cap on the token-collection phase
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);

async function pool(items, size, fn) {
  let i = 0; await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}
async function timed(path, token) {
  const t0 = process.hrtime.bigint();
  try { const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } }); await r.text().catch(() => {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (e) { return { ok: false, status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; }
}
const pctl = (a, p) => { const s2 = [...a].sort((x, y) => x - y); return s2.length ? Math.round(s2[Math.min(s2.length - 1, Math.floor(p / 100 * s2.length))]) : 0; };

(async () => {
  console.log(`LONG distinct-user test → ${BASE}\nProvisioning ${N} accounts, target ${TARGET} distinct tokens...`);
  const emails = Array.from({ length: N }, (_, i) => `loadtest-${String(i + 1).padStart(3, '0')}@${DOMAIN}`);

  // 1) provision (idempotent-ish: createUser fails if exists, then we still try the professionals upsert)
  let created = 0;
  await pool(emails, 10, async (email) => {
    const { data } = await s.auth.admin.createUser({ email, password: PW, email_confirm: true });
    if (data?.user) { const { error } = await s.from('professionals').upsert({ id: data.user.id, role: 'physician', full_name_th: 'โหลดเทสต์', full_name_en: 'Load Test', status: 'active' }, { onConflict: 'id' }); if (!error) created++; }
  });
  console.log(`  created ${created} accounts`);

  // 2) PATIENT adaptive token collection (sequential; backoff lets the per-IP limiter refill)
  console.log('Collecting distinct tokens (patient, adaptive backoff)...');
  await sleep(20000); // let any prior rate-limit budget refill
  const tokens = [];
  const queue = [...emails];
  let gap = 2500, consecFail = 0, attempts = 0, throttled = 0;
  const t0 = now();
  while (queue.length && tokens.length < TARGET && now() - t0 < MAX_LOGIN_MS) {
    const email = queue.shift();
    attempts++;
    let ok = false;
    try {
      const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
      const j = await r.json().catch(() => ({}));
      if (j.access_token) { tokens.push(j.access_token); ok = true; }
    } catch {}
    if (ok) {
      consecFail = 0; gap = Math.max(1500, Math.round(gap * 0.85));
      if (tokens.length % 10 === 0) console.log(`  ${tokens.length} tokens (attempts ${attempts}, throttled ${throttled}, gap ${gap}ms, ${Math.round((now() - t0) / 1000)}s)`);
      await sleep(gap);
    } else {
      throttled++; consecFail++; queue.push(email); // requeue
      gap = Math.min(9000, Math.round(gap * 1.4));
      const backoff = Math.min(60000, 6000 * consecFail);
      await sleep(backoff);
    }
  }
  console.log(`  COLLECTED ${tokens.length} distinct tokens in ${Math.round((now() - t0) / 1000)}s (attempts ${attempts}, throttled ${throttled})`);

  // 3) distinct-user concurrency: every in-flight request uses a DIFFERENT token
  const results = {};
  const levels = [50, 100, tokens.length].filter((v, i, a) => v >= 1 && v <= tokens.length && a.indexOf(v) === i).sort((x, y) => x - y);
  for (const conc of levels) {
    const reqs = []; const rounds = 3;
    for (let r = 0; r < rounds; r++) for (let u = 0; u < conc; u++) reqs.push(tokens[u]);
    const lat = [], errs = {}; let ok = 0, next = 0; const w0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: conc }, async () => {
      while (next < reqs.length) { const idx = next++; const res = await timed(idx % 2 ? '/auth/me' : '/ples', reqs[idx]); lat.push(res.ms); if (res.ok) ok++; else { const k = 'http_' + res.status; errs[k] = (errs[k] || 0) + 1; } }
    }));
    const wall = Number(process.hrtime.bigint() - w0) / 1e6;
    results[conc] = { distinct_users: conc, requests: reqs.length, ok, errors: reqs.length - ok, errorRate: +((reqs.length - ok) / reqs.length * 100).toFixed(2), rps: +(reqs.length / (wall / 1000)).toFixed(1), p50: pctl(lat, 50), p95: pctl(lat, 95), p99: pctl(lat, 99), errs };
    const r = results[conc];
    console.log(`  ${String(conc).padStart(3)} distinct users | ${r.requests} req | ok ${r.ok} | err ${r.errors} (${r.errorRate}%) | ${r.rps} rps | p50 ${r.p50}ms p95 ${r.p95}ms${Object.keys(errs).length ? ' ' + JSON.stringify(errs) : ''}`);
    await sleep(1000);
  }

  // 4) cleanup
  console.log('Cleaning up load-test accounts...');
  let deleted = 0;
  for (let page = 1; ; page++) {
    const { data } = await s.auth.admin.listUsers({ page, perPage: 1000 });
    const lt = data.users.filter(u => u.email?.startsWith('loadtest-') && u.email.endsWith('@' + DOMAIN));
    for (const u of lt) { await s.auth.admin.deleteUser(u.id); deleted++; }
    if (data.users.length < 1000) break;
  }
  const { count: physLeft } = await s.from('professionals').select('id', { count: 'exact', head: true }).eq('role', 'physician');
  console.log(`  deleted ${deleted} accounts · physicians remaining: ${physLeft}`);

  require('fs').writeFileSync('/tmp/loadtest-distinct-long.json', JSON.stringify({ tokens: tokens.length, results }, null, 2));
  const peak = Math.max(...Object.keys(results).map(Number), 0);
  console.log(`\nRESULT: ${tokens.length} distinct tokens; peak concurrency tested = ${peak} distinct users; errors at peak = ${results[peak]?.errors ?? '?'}. Claude $0.`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
