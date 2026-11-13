#!/usr/bin/env node
/*
 * Go-live smoke E2E — runs against the LIVE backend to confirm the Stage-1
 * hardening works end-to-end after deploy:
 *   1. informed-consent gate (POST /ples 403 before consent, passes after)
 *   2. a real chat turn path (content + refs + socratic_question)
 *   3. PLE gate + PIS-7 evaluation fire
 *   4. de-identified study export + reconcile sweep (admin/superadmin)
 *
 * De-identified, hypothetical case only (no patient PII) — matches the pilot rules.
 * Usage: node scripts/smoke/go-live-smoke.js   (BASE overridable via env)
 */
const BASE = require('../lib/api-origin.cjs').apiOrigin(process.env.SMOKE_BASE);
// Live demo cohort (throwaway — rotated before the real pilot per Track B).
const PHYS = { email: process.env.SMOKE_PHYS_EMAIL || 'soakdoc01@example.com', password: process.env.SMOKE_PHYS_PW || 'SoakPass#2026' };
const SUPER = { email: 'superadmin@clics.th', password: process.env.SMOKE_SUPER_PW || 'ClicsSuper#2026r2' };

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// A coherent, de-identified clinical-reasoning dialogue (hypothetical case).
const TURNS = [
  'A 58-year-old presents with central chest tightness on exertion over the past week, relieved by rest. No prior cardiac history. How should I frame my initial differential and the most important rule-outs?',
  'Given exertional angina is my leading hypothesis, what focused history and bedside findings would shift my pre-test probability up or down, and which red flags would make me treat this as an acute coronary syndrome now?',
  'I want to order a 12-lead ECG and high-sensitivity troponin, and start aspirin if ACS is suspected. Walk me through how I should interpret a normal ECG with a mildly raised troponin in this context.',
  'Assuming this stabilises as stable angina rather than ACS, summarise the safety-netting advice and the risk-factor modification I should document before discharge, and what would warrant urgent return.',
];

(async () => {
  console.log(`\n=== CLICS go-live smoke E2E → ${BASE} ===\n`);

  // 1. Physician login
  console.log('1) Physician login');
  const login = await req('POST', '/auth/login', { body: PHYS });
  if (!ok(login.status === 200 && !!login.json?.access_token, 'physician login 200 + token', `status=${login.status}`)) {
    console.log('   cannot continue without a physician token'); return finish();
  }
  const pToken = login.json.access_token;
  const consentedAtLogin = login.json.user?.consented_at ?? null;
  console.log(`   consented_at at login: ${consentedAtLogin ?? 'null'}`);

  // 2. Consent gate BEFORE consent — must 403 consent_required on create AND the session-writing
  //    routes (downstream defense-in-depth), no AI spend. This is only meaningful for a NOT-yet-
  //    consented physician; the shared soak account is usually already consented from prior runs, so
  //    skip (and note) when it is — otherwise the gate-before checks falsely "fail" on a consented user.
  if (!consentedAtLogin) {
    console.log('2) Consent gate (before consent)');
    const blocked = await req('POST', '/ples', { token: pToken, body: { chief_complaint: 'exertional chest pain (hypothetical)' } });
    ok(blocked.status === 403 && blocked.json?.code === 'consent_required',
       'POST /ples blocked 403 consent_required', `status=${blocked.status} code=${blocked.json?.code}`);
    const dummy = '00000000-0000-0000-0000-000000000000';
    const blockedMsg = await req('POST', `/ples/${dummy}/message`, { token: pToken, body: { message: 'x', language: 'en' } });
    ok(blockedMsg.status === 403 && blockedMsg.json?.code === 'consent_required',
       'POST /ples/:id/message blocked before consent', `status=${blockedMsg.status} code=${blockedMsg.json?.code}`);
    const blockedEnd = await req('POST', `/ples/${dummy}/end`, { token: pToken, body: { active_seconds: 1000 } });
    ok(blockedEnd.status === 403 && blockedEnd.json?.code === 'consent_required',
       'POST /ples/:id/end blocked before consent', `status=${blockedEnd.status} code=${blockedEnd.json?.code}`);
  } else {
    console.log(`2) Consent gate (before consent) — SKIPPED: physician already consented at ${consentedAtLogin}`);
  }

  // 3. Record consent
  console.log('3) Record informed consent');
  const consent = await req('POST', '/auth/consent', { token: pToken });
  ok(consent.status === 200 && !!consent.json?.consented_at, 'POST /auth/consent 200 + timestamp', `consented_at=${consent.json?.consented_at}`);

  // 4. Consent gate AFTER consent — must create the session
  console.log('4) Start session (gate should be cleared)');
  const create = await req('POST', '/ples', { token: pToken, body: { chief_complaint: 'exertional chest pain (hypothetical, de-identified)' } });
  if (!ok(create.status === 201 && !!create.json?.id, 'POST /ples 201 + session id', `status=${create.status}`)) {
    return finish();
  }
  const pleId = create.json.id;
  console.log(`   ple_id=${pleId}`);

  // 5. Chat turns — each must return content + refs. socratic_question is emitted ONLY in Socratic
  //    mode (CLE2 examiner / t1-remediation); a natural episode legitimately omits it, so it is
  //    optional here — we count how many turns carried one rather than requiring it on every turn.
  console.log('5) Chat turns (live AI path)');
  let sawSocratic = 0;
  for (let i = 0; i < TURNS.length; i++) {
    const r = await req('POST', `/ples/${pleId}/message`, { token: pToken, body: { message: TURNS[i], language: 'en' } });
    const j = r.json || {};
    const hasSocratic = typeof j.socratic_question === 'string' && j.socratic_question.length > 0;
    if (hasSocratic) sawSocratic++;
    ok(r.status === 200 && typeof j.content === 'string' && j.content.length > 0 && Array.isArray(j.refs),
       `turn ${i + 1}: content + refs[${Array.isArray(j.refs) ? j.refs.length : '?'}]${hasSocratic ? ' + socratic_question' : ''}`,
       `status=${r.status} tokens=${j.token_count ?? '?'}`);
  }
  console.log(`   socratic_question present on ${sawSocratic}/${TURNS.length} turns (expected >0 only in Socratic mode)`);

  // 6. End session → PLE gate
  console.log('6) End session → PLE gate');
  const end = await req('POST', `/ples/${pleId}/end`, { token: pToken, body: { active_seconds: 1000 } });
  ok(end.status === 200 && !!end.json?.status, `POST /ples/:id/end 200`, `status=${end.json?.status} criteria=${JSON.stringify(end.json?.criteria)}`);
  const pleStatus = end.json?.status;

  // 7. If it passed the gate, the PIS-7 evaluation fires — poll for it
  if (pleStatus === 'ple_pass') {
    console.log('7) PIS-7 evaluation (polling up to ~75s)');
    let evaluated = false;
    for (let t = 0; t < 15; t++) {
      await sleep(5000);
      const ev = await req('GET', `/ples/${pleId}/evaluation`, { token: pToken });
      if (ev.status === 200 && ev.json?.composite_score != null) {
        evaluated = true;
        ok(true, 'AI PIS-7 evaluation produced', `composite=${Number(ev.json.composite_score).toFixed(1)} d=[${[1,2,3,4,5,6,7].map(n => ev.json['d'+n]).join(',')}]`);
        break;
      }
    }
    if (!evaluated) ok(false, 'AI PIS-7 evaluation produced', 'did not reach "evaluated" within ~75s (reconcile can recover it later)');
  } else {
    console.log(`7) Skipped PIS-7 poll — gate returned "${pleStatus}" (not ple_pass)`);
  }

  // 8. Superadmin: stats + de-identified export + reconcile
  console.log('8) Admin endpoints (superadmin)');
  const slogin = await req('POST', '/auth/login', { body: SUPER });
  if (!ok(slogin.status === 200 && !!slogin.json?.access_token, 'superadmin login 200 + token', `status=${slogin.status}`)) return finish();
  const sToken = slogin.json.access_token;

  const stats = await req('GET', '/admin/stats', { token: sToken });
  ok(stats.status === 200 && typeof stats.json?.total === 'number', 'GET /admin/stats', JSON.stringify(stats.json));

  // include_test=true so OUR smoke session is present even when pilot_test_mode marks new PLEs is_test
  // (the default export correctly excludes test sessions). The export is pseudonymized either way.
  const exp = await req('GET', '/admin/export?include_test=true', { token: sToken });
  const sessions = exp.json?.sessions ?? [];
  ok(exp.status === 200 && Array.isArray(sessions) && sessions.length >= 1, 'GET /admin/export returns sessions', `n=${exp.json?.n}`);
  // de-identification check: no name/email/raw-id keys leak; physician keyed by pseudonym only
  const leak = sessions.some(s => 'email' in s || 'full_name_th' in s || 'full_name_en' in s || 'physician_id' in s);
  ok(!leak, 'export is de-identified (no email/name/raw-id keys)', leak ? 'LEAK DETECTED' : 'pseudonym-keyed only');
  // auditors are pseudonymized as the protocol EXP-NNN code (CLICS §9.2) or the A-<hash> fallback —
  // never the raw UUID, and no auditor_id key leaks.
  const auditorEntries = sessions.flatMap(s => s.auditor_scores ?? []);
  const audLeak = auditorEntries.some(a => 'auditor_id' in a || !/^(EXP-\d+|A-[0-9a-f]{8})$/.test(a.auditor ?? ''));
  ok(!audLeak, 'auditor scores pseudonymized (EXP-NNN or A-<hash>, no raw auditor_id)',
     auditorEntries.length ? `${auditorEntries.length} entries checked` : 'no auditor scores present to check');
  const mine = sessions.find(s => s.ple_id === pleId);
  ok(!!mine, 'our smoke session present in export', mine ? `physician=${mine.physician} status=${mine.status} ai_composite=${mine.ai_composite}` : 'not found');

  const recon = await req('POST', '/admin/reconcile-evaluations', { token: sToken });
  ok(recon.status === 200 && typeof recon.json?.stuck === 'number', 'POST /admin/reconcile-evaluations', JSON.stringify(recon.json));

  finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function finish() {
  console.log(`\n=== smoke result: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}
