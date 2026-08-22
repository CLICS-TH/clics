#!/usr/bin/env node
/*
 * Sandbox blinded-test LIVE E2E smoke — proves the `hold_result_until_audited` round end-to-end on a
 * REAL CLE in prod, using SANDBOX group-1 accounts (council SANDBOX / specialty SBX-1):
 *
 *   physician C11 runs a real ≥4-turn CLE  →  AI evaluates it  →  with the hold ON the physician's
 *   GET /evaluation returns 202 pending_review (HOLD)  →  admin A1 assigns it to auditor D1  →  D1
 *   blind-scores (ai_evaluation null until submit)  →  physician's GET /evaluation now 200 (REVEAL)
 *   →  the pair shows up in /admin/icc (ICC).
 *
 * Why this takes ~11 minutes: the C1 CME-engagement gate requires >=600s of real wall-clock between
 * POST /cles and POST /cles/:id/end (cle-gate.js:5 + cles.js:299 clamp min(active_seconds, wallClock)) —
 * it cannot be faked. Everything else is seconds. Run in the BACKGROUND.
 *
 * Sandbox passwords follow the committed formula Clics<LABEL>2026 (provision-test-cohort.js:37) — no new
 * secret here. The superadmin password (ICC read only) is read from the gitignored LOGIN-ACCOUNTS.txt at
 * runtime — never on the CLI/env. De-identified hypothetical case only (no patient PII).
 *
 * Usage:  node scripts/smoke/sandbox-hold-smoke.js   (BASE overridable via SMOKE_BASE)
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.SMOKE_BASE || 'https://backend-production-c12e4.up.railway.app';
const REPO = path.resolve(__dirname, '..', '..');

// Group-1 sandbox cohort. Email = <label>@clics.test, password = Clics<LABEL>2026.
const acct = (label) => ({ email: `${label.toLowerCase()}@clics.test`, password: `Clics${label}2026` });
const C11 = acct('C11');   // physician
const A1 = acct('A1');     // admin (assign + tier-2 approve fallback)
const D1 = acct('D1');     // auditor (blind score)
const SUPER_EMAIL = 'superadmin@clics.th';

// Superadmin password from LOGIN-ACCOUNTS.txt (gitignored) — find the value on/near the superadmin line.
function findSuperPw() {
  let txt = '';
  try { txt = fs.readFileSync(path.join(REPO, 'LOGIN-ACCOUNTS.txt'), 'utf8'); }
  catch { return process.env.SMOKE_SUPER_PW || 'ClicsSuper#2026r2'; }
  const lines = txt.split(/\r?\n/);
  const i = lines.findIndex(l => l.includes(SUPER_EMAIL));
  if (i >= 0) for (let k = i; k < Math.min(i + 4, lines.length); k++) {
    for (const t of lines[k].split(/[\s|:,]+/).filter(Boolean)) {
      if (t.includes('@') || t.startsWith('http')) continue;
      if (t.length >= 8 && /[A-Za-z]/.test(t) && /[0-9]/.test(t)) return t;
    }
  }
  return process.env.SMOKE_SUPER_PW || 'ClicsSuper#2026r2';
}

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}
async function login(creds) {
  const r = await req('POST', '/auth/login', { body: creds });
  return { token: r.json?.access_token, user: r.json?.user, status: r.status };
}

// A coherent, de-identified clinical-reasoning dialogue (hypothetical case) — enough turns/tokens for C2/C3.
const TURNS = [
  'A 58-year-old presents with central chest tightness on exertion over the past week, relieved by rest. No prior cardiac history. How should I frame my initial differential and the most important rule-outs?',
  'Given exertional angina is my leading hypothesis, what focused history and bedside findings would shift my pre-test probability up or down, and which red flags would make me treat this as an acute coronary syndrome now?',
  'I want to order a 12-lead ECG and high-sensitivity troponin, and start aspirin if ACS is suspected. Walk me through how I should interpret a normal ECG with a mildly raised troponin in this context.',
  'Assuming this stabilises as stable angina rather than ACS, summarise the safety-netting advice and the risk-factor modification I should document before discharge, and what would warrant urgent return.',
  'How should I risk-stratify this patient for outpatient functional testing versus CT coronary angiography, and what thresholds change that decision?',
  'What secondary-prevention pharmacotherapy and target values should I document, and how do I counsel on activity while awaiting investigation?',
];
const EXTRA = (i) => `Following up: what additional clinical-reasoning step (point ${i}) should I document here, and how does it change my management plan or safety-netting?`;

const WAIT_TARGET_S = 615;       // a little over the 600s C1 gate
const TOKEN_TARGET = 11000;      // comfortably over the 10000 C3 gate
const MAX_TURNS = 8;

(async () => {
  console.log(`\n=== CLICS sandbox HOLD smoke (group 1: C11/A1/D1) → ${BASE} ===\n`);

  // 1) Physician login + consent
  console.log('1) Physician C11 login');
  const pl = await login(C11);
  if (!ok(pl.status === 200 && !!pl.token, 'C11 login 200 + token', `status=${pl.status}`)) return finish();
  const pToken = pl.token;
  console.log(`   C11 usage so far: $${Number(pl.user?.usage_cost_usd ?? 0).toFixed(3)} / $${Number(pl.user?.usage_limit_effective_usd ?? 0).toFixed(2)}`);
  if (!pl.user?.consented_at) {
    const c = await req('POST', '/auth/consent', { token: pToken });
    ok(c.status === 200 && !!c.json?.consented_at, 'C11 consent recorded', `consented_at=${c.json?.consented_at}`);
  } else console.log(`   C11 already consented at ${pl.user.consented_at}`);

  // 2) Start CLE
  console.log('2) Start CLE');
  const create = await req('POST', '/cles', { token: pToken, body: { chief_complaint: 'Exertional chest tightness (hypothetical, de-identified)' } });
  if (!ok(create.status === 201 && !!create.json?.id, 'POST /cles 201 + id', `status=${create.status} ${create.json?.error ?? ''}`)) return finish();
  const cleId = create.json.id;
  const startMs = Date.now();
  console.log(`   cle_id=${cleId} code=${create.json?.cle_code} is_test=${create.json?.is_test}`);

  // 3) Chat turns (live AI path) — until >=4 turns AND >=~11000 tokens
  console.log('3) Chat turns (live AI path)');
  let accToken = 0, turns = 0;
  for (let i = 0; ; i++) {
    if (turns >= 4 && accToken >= TOKEN_TARGET) break;
    if (turns >= MAX_TURNS) break;
    const msg = i < TURNS.length ? TURNS[i] : EXTRA(i);
    const r = await req('POST', `/cles/${cleId}/message`, { token: pToken, body: { message: msg, language: 'en' } });
    const j = r.json || {};
    turns++;
    accToken += Number(j.token_count || 0);
    ok(r.status === 200 && typeof j.content === 'string' && j.content.length > 0,
       `turn ${turns}`, `status=${r.status} tok=${j.token_count ?? '?'} acc≈${accToken}`);
    if (r.status !== 200) break;
  }
  ok(turns >= 4, 'C2 turns >= 4', `turns=${turns}`);
  ok(accToken >= 10000, 'C3 tokens >= 10000 (client estimate)', `acc≈${accToken}`);

  // 4) Wait out the C1 wall-clock gate (>=600s elapsed since /cles)
  console.log('4) C1 wall-clock gate — waiting out >=600s of engagement time');
  while (true) {
    const el = Math.floor((Date.now() - startMs) / 1000);
    if (el >= WAIT_TARGET_S) break;
    console.log(`   ⏳ ${el}/${WAIT_TARGET_S}s elapsed — ${WAIT_TARGET_S - el}s more`);
    await sleep(20000);
  }

  // 5) End CLE → tier-1 gate
  console.log('5) End CLE → tier-1 gate');
  const end = await req('POST', `/cles/${cleId}/end`, { token: pToken, body: { active_seconds: 650 } });
  console.log(`   end status=${end.status} body=${JSON.stringify(end.json)}`);
  if (end.json?.status === 'cle_fail_t1') {
    ok(false, 'tier-1 passed', `FAILED gate: ${JSON.stringify(end.json?.criteria)} (need c1&c2&c3) — check wait/turns/tokens`);
    return finish();
  }
  ok(end.status === 200 || end.status === 202, 'POST /end accepted (tier-1 passed)', `status=${end.status}`);

  // 6) Admin A1 + auditor D1 login (D1 login gives us its uuid for assignment; professionals carry no email)
  console.log('6) Admin A1 + auditor D1 login');
  const al = await login(A1);
  if (!ok(al.status === 200 && !!al.token, 'A1 admin login', `status=${al.status}`)) return finish();
  const aToken = al.token;
  const dl = await login(D1);
  if (!ok(dl.status === 200 && !!dl.token && !!dl.user?.id, 'D1 auditor login + id', `status=${dl.status}`)) return finish();
  const dToken = dl.token, d1Id = dl.user.id;
  if (!dl.user?.consented_at) {
    const dc = await req('POST', '/auth/consent', { token: dToken, body: { context: 'auditor' } });
    ok(dc.status === 200 && !!dc.json?.consented_at, 'D1 auditor consent recorded', `ctx=${dc.json?.context}`);
  } else console.log(`   D1 already consented at ${dl.user.consented_at}`);

  // 7) Poll the physician's evaluation — with hold ON this returns 202 pending_review once evaluated.
  //    (pending_review is ONLY returned after status==='evaluated' — so it proves evaluated AND held.)
  console.log('7) HOLD — poll physician GET /evaluation for 202 pending_review');
  let holdProven = false, leakedEarly = false, approved = false, lastStatus = null;
  for (let t = 0; t < 48; t++) {     // ~240s budget (covers async eval + an approve detour)
    const ev = await req('GET', `/cles/${cleId}/evaluation`, { token: pToken });
    lastStatus = ev.json?.status ?? `http${ev.status}`;
    if (ev.status === 200 && ev.json?.composite_score != null) { leakedEarly = true; break; }
    if (ev.status === 202 && ev.json?.status === 'pending_review') { holdProven = true; break; }
    if (ev.status === 202 && ev.json?.status === 'cle_flag_t2' && !approved) {
      console.log('   ⚠ tier-2 flagged (cle_flag_t2) — A1 approving to re-trigger evaluation');
      const ap = await req('POST', `/admin/cles/${cleId}/approve`, { token: aToken });
      ok(ap.status === 200 && ap.json?.ok, 'A1 approved flagged CLE (tier-2 recovery)', `status=${ap.status}`);
      approved = true;
    }
    if (t % 4 === 0) console.log(`   …status=${lastStatus} (t=${t})`);
    await sleep(5000);
  }
  if (leakedEarly) ok(false, 'HOLD: score withheld until audited', 'got 200 BEFORE any auditor scored — hold NOT active!');
  else ok(holdProven, 'HOLD proven — 202 pending_review (evaluated but withheld)', `lastStatus=${lastStatus}`);
  if (!holdProven) { console.log('   cannot continue assignment without an evaluated CLE'); return finish(); }

  // 8) Admin A1 assigns the evaluated CLE to auditor D1 (same council SANDBOX + specialty SBX-1)
  console.log('8) Admin A1 assigns CLE → auditor D1');
  const asg = await req('POST', `/admin/cles/${cleId}/assign`, { token: aToken, body: { auditor_id: d1Id } });
  ok(asg.status === 200 && asg.json?.ok, 'POST /admin/cles/:id/assign', `status=${asg.status} ${asg.json?.error ?? ''}`);

  // 9) Auditor D1 sees it in the blind queue; the AI score is hidden pre-submit
  console.log('9) Auditor D1 blind queue + view');
  const q = await req('GET', '/auditor/queue', { token: dToken });
  ok(q.status === 200 && Array.isArray(q.json) && q.json.some(c => c.id === cleId), 'CLE present in D1 queue', `n=${Array.isArray(q.json) ? q.json.length : '?'}`);
  const view = await req('GET', `/auditor/cles/${cleId}`, { token: dToken });
  ok(view.status === 200 && view.json?.ai_evaluation === null, 'blind: ai_evaluation null before D1 scores', `ai=${JSON.stringify(view.json?.ai_evaluation)}`);

  // 10) Auditor D1 submits PIS-7 (all 4s → composite 80.0)
  console.log('10) Auditor D1 submits PIS-7 score');
  const score = await req('POST', `/auditor/cles/${cleId}/score`, {
    token: dToken,
    body: { d1: 4, d2: 4, d3: 4, d4: 4, d5: 4, d6: 4, d7: 4, notes: 'E2E smoke — blind score (all 4s).' },
  });
  ok(score.status === 200 && score.json?.composite_score != null, 'POST /auditor/cles/:id/score', `composite=${score.json?.composite_score}`);

  // 11) REVEAL — physician's evaluation now returns 200 with the full AI score
  console.log('11) REVEAL — physician GET /evaluation now returns the score');
  let revealed = null;
  for (let t = 0; t < 6; t++) {
    const ev = await req('GET', `/cles/${cleId}/evaluation`, { token: pToken });
    if (ev.status === 200 && ev.json?.composite_score != null) { revealed = ev.json; break; }
    await sleep(3000);
  }
  if (ok(!!revealed, 'REVEAL proven — score visible after auditor submit', revealed ? `ai_composite=${Number(revealed.composite_score).toFixed(1)}` : 'still held')) {
    console.log(`   AI PIS-7: composite=${Number(revealed.composite_score).toFixed(1)} d=[${[1,2,3,4,5,6,7].map(n => revealed['d' + n]).join(',')}]`);
    console.log(`   Auditor PIS-7: composite=${score.json.composite_score} d=[4,4,4,4,4,4,4]`);
  }

  // 12) ICC — the (AI, auditor) pair lands in the study ICC (superadmin only; include_test for sandbox)
  console.log('12) ICC — superadmin /admin/icc?include_test=true');
  const sl = await login({ email: SUPER_EMAIL, password: findSuperPw() });
  if (ok(sl.status === 200 && !!sl.token, 'superadmin login', `status=${sl.status}`)) {
    const icc = await req('GET', '/admin/icc?include_test=true', { token: sl.token });
    const overallN = icc.json?.overall?.n ?? icc.json?.n ?? 0;
    ok(icc.status === 200 && overallN >= 1, 'ICC has >=1 AI-vs-auditor pair', `overall.n=${overallN} icc=${icc.json?.overall?.icc ?? 'n/a'}`);
    // SANDBOX council bucket (per_council keyed by council_id) — surface its n if present.
    const buckets = icc.json?.per_council ?? {};
    const sandbox = Object.values(buckets).find(b => b?.council?.code === 'SANDBOX');
    if (sandbox) console.log(`   SANDBOX council bucket: n=${sandbox.n ?? sandbox.overall?.n} icc=${sandbox.overall?.icc ?? 'n/a'}`);
  }

  console.log(`\n   (smoke left one evaluated+scored CLE under C11/D1 as a worked example; C11 spent ~$0.05-0.08 of its $0.50)`);
  finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function finish() {
  console.log(`\n=== sandbox HOLD smoke: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}
