#!/usr/bin/env node
/*
 * Provision REAL pilot participants — ADDITIVE and NON-DESTRUCTIVE.
 *
 * Creates physician accounts from a roster via the real superadmin path
 * (POST /admin/users), so role-slot limits and P-NNN pseudonyms apply exactly as in the app.
 * It NEVER deletes or overwrites anything — the existing demo/soak test history stays intact
 * for your manager to review. (Clearing the demo cohort is a separate, deliberate step:
 * `node db/reset-demo.js` — not done here.)
 *
 * Each participant gets a unique strong password, written to a gitignored credentials file
 * for you to distribute through a secure channel.
 *
 * SAFE BY DEFAULT: dry-run unless you pass --confirm.
 *
 * Usage:
 *   1. cp scripts/provision/roster.example.json scripts/provision/roster.json   (edit it)
 *   2. node scripts/provision/provision-participants.js                 # dry-run, no writes
 *   3. node scripts/provision/provision-participants.js --confirm       # actually create
 *
 * Env (override as needed):
 *   PROVISION_BASE           backend URL (default: prod)
 *   PROVISION_SUPERADMIN_EMAIL / PROVISION_SUPERADMIN_PW   superadmin login
 *   PROVISION_ROSTER         roster path (default: scripts/provision/roster.json)
 */
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const BASE = process.env.PROVISION_BASE || 'https://backend-production-c12e4.up.railway.app';
const SUPER = {
  email: process.env.PROVISION_SUPERADMIN_EMAIL || 'superadmin@clics.th',
  password: process.env.PROVISION_SUPERADMIN_PW || 'ClicsSuper#2026r2',
};
const ROSTER = process.env.PROVISION_ROSTER || path.join('scripts', 'provision', 'roster.json');
const CONFIRM = process.argv.includes('--confirm');

// Strong, unique, easy-to-read-aloud password that satisfies the account policy (letter + digit, long).
function genPassword() {
  const body = randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  const digit = randomBytes(1)[0] % 10;
  return `Clx${body}${digit}`; // e.g. ClxA7bQ2k9m4 — always has letters + a digit, ~13 chars
}

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
  if (!fs.existsSync(ROSTER)) {
    console.error(`✗ Roster not found: ${ROSTER}\n  Copy the template and edit it:\n    cp scripts/provision/roster.example.json ${ROSTER}`);
    process.exit(1);
  }
  let roster;
  try { roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8')); }
  catch (e) { console.error(`✗ Roster is not valid JSON: ${e.message}`); process.exit(1); }
  if (!Array.isArray(roster) || !roster.length) { console.error('✗ Roster must be a non-empty JSON array.'); process.exit(1); }

  // Validate every entry up front so a dry-run catches roster mistakes.
  const problems = [];
  roster.forEach((p, i) => {
    if (!p.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) problems.push(`#${i + 1}: missing/invalid email`);
    if (!p.full_name_th) problems.push(`#${i + 1} (${p.email}): missing full_name_th`);
    if (!p.full_name_en) problems.push(`#${i + 1} (${p.email}): missing full_name_en`);
  });
  if (problems.length) { console.error('✗ Roster validation failed:\n  ' + problems.join('\n  ')); process.exit(1); }

  console.log(`\nCLICS participant provisioning  →  ${BASE}`);
  console.log(`Roster: ${ROSTER}  (${roster.length} participant${roster.length === 1 ? '' : 's'})`);
  console.log(CONFIRM ? '** MODE: --confirm (will CREATE accounts) **\n' : '** MODE: dry-run (no accounts created — pass --confirm to apply) **\n');

  if (!CONFIRM) {
    roster.forEach((p, i) => console.log(`  would create  ${String(i + 1).padStart(2)}. ${p.email.padEnd(34)} ${p.full_name_en}`));
    console.log('\nNo changes made. Re-run with --confirm to create these accounts.\n');
    return;
  }

  const login = await req('POST', '/auth/login', { body: SUPER });
  if (login.status !== 200 || !login.json?.access_token) {
    console.error(`✗ Superadmin login failed (status ${login.status}). Set PROVISION_SUPERADMIN_PW.`); process.exit(1);
  }
  const token = login.json.access_token;

  const created = [], skipped = [], failed = [];
  for (const p of roster) {
    const password = genPassword();
    const r = await req('POST', '/admin/users', { token, body: {
      email: p.email, password, role: 'physician',
      full_name_th: p.full_name_th, full_name_en: p.full_name_en,
      specialty: p.specialty || undefined, license_number: p.license_number || undefined,
    }});
    if (r.status === 201) {
      created.push({ email: p.email, name: p.full_name_en, pseudonym: r.json?.pseudonym ?? '?', password });
      console.log(`  ✓ ${p.email.padEnd(34)} ${r.json?.pseudonym ?? ''}`);
    } else if (r.status === 400 && /registered|exists/i.test(JSON.stringify(r.json))) {
      skipped.push(p.email); console.log(`  · ${p.email.padEnd(34)} already exists — skipped`);
    } else if (r.status === 409) {
      failed.push({ email: p.email, why: r.json?.error || 'slot pool full' });
      console.log(`  ✗ ${p.email.padEnd(34)} ${r.json?.error || 'slot full'} — stopping`); break;
    } else {
      failed.push({ email: p.email, why: `status ${r.status}: ${JSON.stringify(r.json)}` });
      console.log(`  ✗ ${p.email.padEnd(34)} status ${r.status}`);
    }
  }

  if (created.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join('scripts', 'provision', `credentials-${stamp}.txt`); // gitignored
    const lines = [
      `CLICS pilot participant credentials — generated ${new Date().toISOString()}`,
      `Backend: ${BASE}   Portal: https://physician-ui.vercel.app`,
      `DISTRIBUTE SECURELY. Each participant should change nothing — these are their login + pseudonym.`,
      '',
      ...created.map(c => `${c.pseudonym}  ${c.name}\n  email:    ${c.email}\n  password: ${c.password}\n`),
    ];
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`\n✓ Wrote ${created.length} credential set(s) → ${outPath}  (gitignored)`);
  }
  console.log(`\nSummary: ${created.length} created, ${skipped.length} already-existing, ${failed.length} failed.`);
  console.log('No existing data was modified or deleted.\n');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
