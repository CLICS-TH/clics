#!/usr/bin/env node
/*
 * Provision the SANDBOX TEST COHORT — ADDITIVE and NON-DESTRUCTIVE.
 *
 * Creates the 12 test accounts (3 admins + 3 auditors + 6 physicians) from
 * scripts/provision/test-cohort.json via the real superadmin path (POST /admin/users), so
 * role-slot limits, specialty scoping, and P-NNN pseudonyms apply exactly as in the app.
 * Each group (1 admin + 1 auditor + 2 physicians) lives in one sandbox specialty (SBX-1/2/3)
 * under the isolated SANDBOX council — so the blind-audit pipeline routes each group separately.
 *
 * Passwords are SIMPLE + per-account: `Clics<LABEL>2026` (e.g. ClicsC112026, ClicsD12026) — ≥10
 * chars, letter+digit, easy to type on a phone. Written to a gitignored credentials file.
 *
 * Prereqs: apply db/migration-sandbox-specialties.sql first (creates SANDBOX + SBX-1..5 + slots).
 * SAFE BY DEFAULT: dry-run unless you pass --confirm.
 *
 * Usage:
 *   node scripts/provision/provision-test-cohort.js              # dry-run, no writes
 *   node scripts/provision/provision-test-cohort.js --confirm    # actually create
 *
 * Env (set the superadmin password from LOGIN-ACCOUNTS.txt — NEVER on the command line):
 *   PROVISION_BASE           backend URL (default: prod)
 *   PROVISION_SUPERADMIN_EMAIL / PROVISION_SUPERADMIN_PW   superadmin login
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.PROVISION_BASE || 'https://backend-production-c12e4.up.railway.app';
const SUPER = {
  email: process.env.PROVISION_SUPERADMIN_EMAIL || 'superadmin@clics.th',
  password: process.env.PROVISION_SUPERADMIN_PW || 'ClicsSuper#2026r2',
};
const ROSTER = process.env.PROVISION_ROSTER || path.join('scripts', 'provision', 'test-cohort.json');
const CONFIRM = process.argv.includes('--confirm');

// Simple, per-account, mobile-typable password that satisfies the policy (≥10 chars, letter + digit).
const passwordFor = (label) => `Clics${label}2026`;

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

(async () => {
  if (!fs.existsSync(ROSTER)) { console.error(`✗ Roster not found: ${ROSTER}`); process.exit(1); }
  let roster;
  try { roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8')); }
  catch (e) { console.error(`✗ Roster is not valid JSON: ${e.message}`); process.exit(1); }
  if (!Array.isArray(roster) || !roster.length) { console.error('✗ Roster must be a non-empty JSON array.'); process.exit(1); }

  const problems = [];
  roster.forEach((p, i) => {
    if (!p.label) problems.push(`#${i + 1}: missing label (drives the password)`);
    if (!p.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) problems.push(`#${i + 1}: missing/invalid email`);
    if (!['admin', 'auditor', 'physician'].includes(p.role)) problems.push(`#${i + 1} (${p.email}): role must be admin|auditor|physician`);
    if (!p.council) problems.push(`#${i + 1} (${p.email}): missing council code`);
    if (!p.full_name_th || !p.full_name_en) problems.push(`#${i + 1} (${p.email}): missing name`);
  });
  if (problems.length) { console.error('✗ Roster validation failed:\n  ' + problems.join('\n  ')); process.exit(1); }

  console.log(`\nCLICS sandbox test-cohort provisioning  →  ${BASE}`);
  console.log(`Roster: ${ROSTER}  (${roster.length} accounts)`);
  console.log(CONFIRM ? '** MODE: --confirm (will CREATE accounts) **\n' : '** MODE: dry-run (no accounts created — pass --confirm) **\n');

  const login = await req('POST', '/auth/login', { body: SUPER });
  if (login.status !== 200 || !login.json?.access_token) {
    console.error(`✗ Superadmin login failed (status ${login.status}). Set PROVISION_SUPERADMIN_PW (from LOGIN-ACCOUNTS.txt).`); process.exit(1);
  }
  const token = login.json.access_token;

  // Resolve council + specialty codes → ids (a dry-run already catches a missing SANDBOX migration).
  const byCouncil = Object.fromEntries(((await req('GET', '/admin/councils', { token })).json ?? []).map(c => [c.code, c.id]));
  const specRows = (await req('GET', '/admin/specialties', { token })).json ?? [];
  const bySpecialty = {}; // `${council_id}:${code}` → specialty_id
  for (const s of specRows) bySpecialty[`${s.council_id}:${s.code}`] = s.id;

  const resolved = roster.map(p => {
    const council_id = byCouncil[p.council];
    const specialty_id = council_id && p.specialty ? bySpecialty[`${council_id}:${p.specialty}`] : null;
    return { ...p, council_id, specialty_id, password: passwordFor(p.label) };
  });
  const unresolved = resolved.filter(p => !p.council_id || (p.specialty && !p.specialty_id));
  if (unresolved.length) {
    console.error('✗ Could not resolve council/specialty for:\n  ' + unresolved.map(p => `${p.email} (council ${p.council}, specialty ${p.specialty})`).join('\n  '));
    console.error('  → apply db/migration-sandbox-specialties.sql first.');
    process.exit(1);
  }

  if (!CONFIRM) {
    resolved.forEach((p, i) => console.log(`  would create  ${String(i + 1).padStart(2)}. ${p.role.padEnd(9)} ${p.email.padEnd(16)} ${p.council}/${p.specialty}  pw=${p.password}`));
    console.log('\nNo changes made. Re-run with --confirm to create these accounts.\n');
    return;
  }

  const created = [], skipped = [], failed = [];
  for (const p of resolved) {
    const r = await req('POST', '/admin/users', { token, body: {
      email: p.email, password: p.password, role: p.role, council_id: p.council_id,
      specialty_id: p.specialty_id || undefined,
      full_name_th: p.full_name_th, full_name_en: p.full_name_en,
    }});
    if (r.status === 201) {
      created.push({ label: p.label, role: p.role, email: p.email, pseudonym: r.json?.pseudonym ?? '', password: p.password });
      console.log(`  ✓ ${p.role.padEnd(9)} ${p.email.padEnd(16)} ${r.json?.pseudonym ?? ''}`);
    } else if (r.status === 400 && /registered|exists/i.test(JSON.stringify(r.json))) {
      skipped.push(p.email); console.log(`  · ${p.email.padEnd(16)} already exists — skipped`);
    } else if (r.status === 409) {
      failed.push({ email: p.email, why: r.json?.error || 'slot pool full' });
      console.log(`  ✗ ${p.email.padEnd(16)} ${r.json?.error || 'slot full'} — stopping`); break;
    } else {
      failed.push({ email: p.email, why: `status ${r.status}: ${JSON.stringify(r.json)}` });
      console.log(`  ✗ ${p.email.padEnd(16)} status ${r.status}`);
    }
  }

  if (created.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join('scripts', 'provision', `test-credentials-${stamp}.txt`); // gitignored
    const lines = [
      `CLICS sandbox test-cohort credentials — generated ${new Date().toISOString()}`,
      `Backend: ${BASE}   Portal: https://physician-ui.vercel.app`,
      `SANDBOX council only — no access to real data. Distribute to the test team.`,
      '',
      ...created.map(c => `${c.label}  (${c.role})  ${c.pseudonym}\n  email:    ${c.email}\n  password: ${c.password}\n`),
    ];
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`\n✓ Wrote ${created.length} credential set(s) → ${outPath}  (gitignored)`);
  }
  console.log(`\nSummary: ${created.length} created, ${skipped.length} already-existing, ${failed.length} failed.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
