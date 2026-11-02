#!/usr/bin/env node
/*
 * New-auth E2E — exercises the Google + invite onboarding surface (License No. + TMC retired
 * 2026-06-09) against a REAL Supabase (use clics-scaletest — NEVER prod). Complements the
 * hermetic backend/tests/auth-flows.test.js by proving real-DB provisioning + slot pools.
 *
 * PROVES (automated, no email/Google needed):
 *   - public councils list; public email-OTP self-signup is RETIRED (/auth/signup/email → 404)
 *   - forgot-password always 200; Google gate (404 when OAUTH disabled, else 401 on a bogus token)
 *   - admin-provision path: POST /admin/users → P-NNN pseudonym → the account can log in
 *   - invite lifecycle: create → GET shows bound email/role/council → revoke → 404; duplicate → 409
 *   - invite ACCEPT → ACTIVE on accept for BOTH physician AND auditor (the A/B invite is the gate;
 *     no license check, no pending_license_review)
 *
 * STAYS MANUAL (real inbox / Google consent — see docs/E2E-RUNBOOK.md):
 *   - real OTP email delivery; real Google sign-in. The accept path below pulls codes via the
 *     Supabase admin API (no email) and soft-fails (⚠) if live OTP mechanics differ.
 *
 * REQUIRES: a backend running against the test Supabase + the service-role key (OTP + cleanup).
 * RUN (from backend/ so node resolves @supabase/supabase-js + loads backend/.env):
 *   cd backend && E2E_BASE=http://localhost:3001 node ../scripts/e2e/new-auth-e2e.js --confirm
 *
 * ENV: E2E_BASE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, E2E_SUPER_EMAIL/PW,
 *      E2E_COUNCIL (default TMC; use an emptier council if slots are full), E2E_EMAIL_DOMAIN.
 *
 * SAFE BY DEFAULT: dry-run unless --confirm (creates + deletes test users on the target DB).
 */
try { require('dotenv').config(); } catch { /* dotenv optional; env may be exported instead */ }

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const SUPER = {
  email: process.env.E2E_SUPER_EMAIL || 'superadmin@clics.th',
  password: process.env.E2E_SUPER_PW || process.env.SEED_SUPERADMIN_PW || 'ClicsSuper#2026r2',
};
const COUNCIL_CODE = process.env.E2E_COUNCIL || 'TMC';
const EMAIL_DOMAIN = process.env.E2E_EMAIL_DOMAIN || 'e2e.clics.test';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONFIRM = process.argv.includes('--confirm');
const PASSWORD = 'E2ePass#2026x';            // satisfies the ≥10 + letter + digit policy

const uniqEmail = (tag) => `e2e+${tag}.${Date.now().toString(36)}.${Math.floor(Math.random() * 1e4)}@${EMAIL_DOMAIN}`;

let pass = 0, fail = 0, warn = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
};
const soft = (label, why) => { warn++; console.log(`  ⚠️  SKIP ${label}${why ? ' — ' + why : ''}`); };
const info = (m) => console.log(`  ·  ${m}`);

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = (c) => req('POST', '/auth/login', { body: c });

// ---- Supabase admin (service role): OTP without email + test-data cleanup --------------------
let admin = null;
function getAdmin() {
  if (admin || !SUPABASE_URL || !SERVICE_KEY) return admin;
  const { createClient } = require('@supabase/supabase-js');
  admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
// Obtain a verifiable OTP for `email` WITHOUT sending mail (generateLink returns the code + user id).
async function getOtp(email) {
  const a = getAdmin(); if (!a) return null;
  try {
    const { data, error } = await a.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) return null;
    if (data?.user?.id) track(email, data.user.id);
    return data?.properties?.email_otp || null;
  } catch { return null; }
}

const tracked = new Map();                                   // email → auth user id (for cleanup)
const track = (email, id) => { if (!tracked.has(email) || id) tracked.set(email, id || tracked.get(email)); };

async function cleanup() {
  const a = getAdmin(); if (!a) return;
  console.log('\nF) Cleanup — removing test accounts');
  let removed = 0;
  for (const [email, knownId] of tracked) {
    let id = knownId;
    if (!id) { try { const { data } = await a.auth.admin.generateLink({ type: 'magiclink', email }); id = data?.user?.id; } catch {} }
    try {
      await a.from('invites').delete().eq('email', email);
      await a.from('access_requests').delete().eq('email', email);
      if (id) {
        await a.from('oauth_identities').delete().eq('auth_user_id', id);
        await a.from('professionals').delete().eq('id', id);
        await a.auth.admin.deleteUser(id).catch(() => {});
        removed++;
      }
    } catch (e) { info(`cleanup ${email}: ${e.message}`); }
  }
  info(`removed ${removed}/${tracked.size} test account(s)`);
}

// ---- the run ---------------------------------------------------------------------------------
(async () => {
  console.log(`\n=== CLICS new-auth E2E (Google + invite model) → ${BASE} ===`);
  console.log(`    test Supabase: ${SUPABASE_URL || '(not set — accept + cleanup paths will be skipped)'}`);
  console.log(`    council=${COUNCIL_CODE}  email-domain=${EMAIL_DOMAIN}\n`);
  if (!CONFIRM) {
    console.log('** dry-run (no accounts created). Re-run with --confirm to execute the live E2E. **');
    console.log('   It will CREATE and then DELETE throwaway accounts on the target DB — never point at prod.\n');
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    info('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — the invite-accept + cleanup paths are skipped; negative/gate paths still run.');
  }

  // ---- A) public + negative paths (no auth, no email) ----
  console.log('A) Public + validation paths');
  const councils = await req('GET', '/auth/councils');
  const list = Array.isArray(councils.json) ? councils.json : [];
  ok(councils.status === 200 && list.length >= 1, 'GET /auth/councils (public picker)', `n=${list.length}`);
  const council = list.find(c => c.code === COUNCIL_CODE) || list[0];
  if (!council) { ok(false, `council "${COUNCIL_CODE}" available`, 'no councils — run migration-councils.sql'); return finish(); }
  const council_id = council.id;
  info(`using council ${council.code} (${council_id})`);

  const retired = await req('POST', '/auth/signup/email', { body: {
    email: uniqEmail('retired'), password: PASSWORD, council_id, full_name_th: 'ก', full_name_en: 'A' } });
  ok(retired.status === 404, 'public email-OTP self-signup retired → /auth/signup/email 404', `status=${retired.status}`);

  const forgot = await req('POST', '/auth/forgot-password', { body: { email: uniqEmail('forgot') } });
  ok(forgot.status === 200 && forgot.json?.ok, 'forgot-password → 200 (no existence leak)', `status=${forgot.status}`);

  const g = await req('POST', '/auth/oauth/google/complete', { body: { access_token: 'bogus.token.value', council_id } });
  ok([404, 401].includes(g.status), 'Google complete gate (404 disabled / 401 bogus token)', `status=${g.status}`);
  info(g.status === 404 ? 'OAUTH_ENABLED is unset — Google gated off (expected pre-config)' : 'OAUTH_ENABLED=true — rejected a bogus token as expected');

  // ---- B) superadmin login (drives invites + provision) ----
  console.log('B) Superadmin');
  const sa = await login(SUPER);
  if (!ok(sa.status === 200 && sa.json?.access_token, 'superadmin login', `status=${sa.status}`)) return finish();
  const saT = sa.json.access_token;

  // ---- C) admin-provision path (the simplest onboarding) ----
  console.log('C) Admin-provision path (POST /admin/users)');
  const provEmail = uniqEmail('prov');
  const prov = await req('POST', '/admin/users', { token: saT, body: {
    email: provEmail, password: PASSWORD, role: 'physician', council_id,
    full_name_th: 'หมอ ทดสอบ', full_name_en: 'Provisioned MD',
  }});
  if (prov.status === 201) {
    track(provEmail, prov.json?.id || prov.json?.user?.id || null);
    ok(/^P-\d+/.test(prov.json?.pseudonym || ''), 'provision physician → P-NNN pseudonym', prov.json?.pseudonym);
    const pl = await login({ email: provEmail, password: PASSWORD });
    ok(pl.status === 200 && pl.json?.user?.role === 'physician', 'provisioned physician can log in', `status=${pl.status}`);
  } else if (prov.status === 409 && /slot/i.test(JSON.stringify(prov.json))) {
    soft('admin-provision', `physician slots full in ${council.code} (80K seed?) — set E2E_COUNCIL to an empty council`);
  } else {
    ok(false, 'POST /admin/users (provision physician)', `status=${prov.status} ${JSON.stringify(prov.json)}`);
  }

  // ---- D) invite lifecycle (create → bound view → revoke → 404; duplicate → 409) ----
  console.log('D) Invite lifecycle');
  const invEmail = uniqEmail('inv');
  const mk = await req('POST', '/admin/invites', { token: saT, body: { email: invEmail, role: 'physician', council_id } });
  if (mk.status === 201) {
    const rawToken = new URL(mk.json.accept_url).searchParams.get('token');
    ok(!!rawToken, 'POST /admin/invites → 201 with accept_url token', mk.json?.id);
    const view = await req('GET', `/auth/invite/${rawToken}`);
    ok(view.status === 200 && view.json?.email === invEmail && view.json?.role === 'physician' && view.json?.council,
       'GET /auth/invite/:token shows bound email/role/council', `${view.json?.email} ${view.json?.role}`);
    const dup = await req('POST', '/admin/invites', { token: saT, body: { email: invEmail, role: 'physician', council_id } });
    ok(dup.status === 409, 'duplicate pending invite (same email+role) → 409', `status=${dup.status}`);
    const del = await req('DELETE', `/admin/invites/${mk.json.id}`, { token: saT });
    ok(del.status === 200, 'DELETE /admin/invites/:id (revoke) → 200', `status=${del.status}`);
    const gone = await req('GET', `/auth/invite/${rawToken}`);
    ok(gone.status === 404, 'revoked invite → GET 404', `status=${gone.status}`);
  } else if (mk.status === 409 && /slot/i.test(JSON.stringify(mk.json))) {
    soft('invite lifecycle', `physician slots full in ${council.code} — set E2E_COUNCIL to an empty council`);
  } else {
    ok(false, 'POST /admin/invites', `status=${mk.status} ${JSON.stringify(mk.json)}`);
  }

  // ---- E) invite ACCEPT → ACTIVE on accept for BOTH roles (the A/B invite is the gate) ----
  console.log('E) Invite accept → active on accept (no license gate)');
  await acceptInvite({ tag: 'phys', role: 'physician', saT, council_id });
  await acceptInvite({ tag: 'aud', role: 'auditor', saT, council_id });   // KEY: auditor active on accept now

  return finish();
})().catch(e => { console.error('FATAL', e); finish(1); });

// Run one invite → password-OTP accept and assert it lands ACTIVE on the real DB (no license gate).
async function acceptInvite({ tag, role, saT, council_id }) {
  const email = uniqEmail(tag);
  const mk = await req('POST', '/admin/invites', { token: saT, body: { email, role, council_id } });
  if (mk.status === 409 && /slot/i.test(JSON.stringify(mk.json))) return soft(`${role} ${tag}`, `${role} slots full in this council`);
  if (mk.status !== 201) return ok(false, `invite (${tag}) create`, `status=${mk.status} ${JSON.stringify(mk.json)}`);
  const token = new URL(mk.json.accept_url).searchParams.get('token');
  track(email, null);

  const names = { full_name_th: `ผู้ใช้ ${tag}`, full_name_en: `User ${tag}` };
  const step1 = await req('POST', `/auth/invite/${token}/accept`, { body: { method: 'password', password: PASSWORD, ...names } });
  if (step1.status !== 202) return ok(false, `invite accept step1 (${tag}) → otp_sent`, `status=${step1.status} ${JSON.stringify(step1.json)}`);

  const otp = await getOtp(email);
  if (!otp) return soft(`invite accept ${tag}`, 'could not obtain an OTP via the admin API (set SUPABASE_* or verify generateLink)');

  const step2 = await req('POST', `/auth/invite/${token}/accept`, { body: { method: 'password', otp, password: PASSWORD, ...names } });
  if (step2.json?.user?.id) track(email, step2.json.user.id);
  if (ok(step2.status === 201, `${role} ${tag}: invite accept → 201`, `got ${step2.status} ${JSON.stringify(step2.json?.status || step2.json)}`)) {
    ok(step2.json?.status === 'active', `${role} ${tag}: status=active on accept`, step2.json?.status);
  }
}

async function finish(code) {
  try { await cleanup(); } catch (e) { info(`cleanup error: ${e.message}`); }
  console.log(`\n=== new-auth E2E: ${pass} passed, ${fail} failed, ${warn} skipped ===\n`);
  process.exit(code != null ? code : (fail ? 1 : 0));
}
