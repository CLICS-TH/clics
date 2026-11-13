#!/usr/bin/env node
/*
 * Live role-chain smoke — proves the Admin → Auditor → Superadmin flow end to end
 * against the deployed backend, with NO AI spend (assignment + scoring are pure CRUD):
 *   Superadmin: sees all roles + role-slot pool + stats + ICC
 *   Admin:      lists evaluated sessions + auditors + invites, assigns a session
 *   Auditor:    sees only its blind queue (no physician identity), scores a session
 *   Superadmin: the auditor score reaches ICC + the de-identified export
 *
 * Usage: node scripts/smoke/role-chain-smoke.js
 */
const BASE = require('../lib/api-origin.cjs').apiOrigin(process.env.SMOKE_BASE);
const SUPER = { email: 'superadmin@clics.th', password: process.env.SMOKE_SUPER_PW || 'ClicsSuper#2026r2' };
const ADMIN = { email: 'admin@clics.th', password: process.env.SMOKE_ADMIN_PW || 'ClicsAdmin#2026r2' };
const AUDITOR = { email: process.env.SMOKE_AUD_EMAIL || 'soakaud1@example.com', password: process.env.SMOKE_AUD_PW || 'SoakPass#2026' };

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
};
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
const login = async (c) => (await req('POST', '/auth/login', { body: c }));

// keys that would reveal physician identity to a blind auditor
const ID_KEYS = ['physician_id', 'full_name_th', 'full_name_en', 'pseudonym', 'professionals', 'email', 'specialty'];
const leaksIdentity = (obj) => {
  const seen = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) { if (ID_KEYS.includes(k) && o[k] != null) seen.push(k); walk(o[k]); }
  };
  walk(obj);
  return seen;
};

(async () => {
  console.log(`\n=== CLICS role-chain smoke → ${BASE} ===\n`);

  // ---- SUPERADMIN: monitor all roles + manage pool ----
  console.log('A) Superadmin — monitor everything + manage pool');
  const sa = await login(SUPER);
  if (!ok(sa.status === 200 && sa.json?.access_token, 'superadmin login', `status=${sa.status}`)) return finish();
  const saT = sa.json.access_token;

  // The list is paginated (default 50) and the roster is larger, so page 1 alone can miss a role
  // entirely — the superadmin, of which there is exactly one. Ask for the whole roster.
  const users = await req('GET', '/admin/users?limit=200', { token: saT });
  const roles = (users.json ?? []).reduce((a, u) => (a[u.role] = (a[u.role] ?? 0) + 1, a), {});
  ok(users.status === 200 && Array.isArray(users.json) && ['superadmin','admin','auditor','physician'].every(r => roles[r] > 0),
     'GET /admin/users sees all four roles', JSON.stringify(roles));

  const slots = await req('GET', '/admin/slots', { token: saT });
  ok(slots.status === 200 && Array.isArray(slots.json) && slots.json.length >= 4, 'GET /admin/slots (role pool)',
     (slots.json ?? []).map(s => `${s.role}:${s.capacity}`).join(' '));

  const stats = await req('GET', '/admin/stats', { token: saT });
  ok(stats.status === 200 && typeof stats.json?.total === 'number', 'GET /admin/stats (outcome counts)', JSON.stringify(stats.json));

  const iccBefore = await req('GET', '/admin/icc', { token: saT });
  ok(iccBefore.status === 200, 'GET /admin/icc (agreement metric)', `icc=${iccBefore.json?.icc ?? 'null'} n=${iccBefore.json?.n ?? 0}`);

  // ---- find the auditor's own id via /auth/me (queue is keyed by auditor_id) ----
  console.log('B) Auditor identity');
  const au = await login(AUDITOR);
  if (!ok(au.status === 200 && au.json?.access_token, `auditor login (${AUDITOR.email})`, `status=${au.status}`)) return finish();
  const auT = au.json.access_token;
  const me = await req('GET', '/auth/me', { token: auT });
  const auditorId = me.json?.user?.id;
  ok(!!auditorId && me.json?.user?.role === 'auditor', 'GET /auth/me returns auditor id', `id=${auditorId}`);

  // ---- ADMIN: list evaluated sessions, auditors, requests; assign ----
  console.log('C) Admin — organize sessions + manage invites');
  let adminT = saT, adminAs = 'superadmin (admin login unavailable)';
  const ad = await login(ADMIN);
  if (ad.status === 200 && ad.json?.access_token) { adminT = ad.json.access_token; adminAs = ADMIN.email; }
  info(`acting as admin: ${adminAs}`);

  const evald = await req('GET', '/admin/ples?status=evaluated&limit=200', { token: adminT });
  const evList = evald.json ?? [];
  ok(evald.status === 200 && Array.isArray(evList), 'GET /admin/ples?status=evaluated', `n=${evList.length}`);

  const auditors = await req('GET', '/admin/auditors', { token: adminT });
  ok(auditors.status === 200 && Array.isArray(auditors.json) && auditors.json.length >= 1, 'GET /admin/auditors (assign dropdown)', `n=${auditors.json?.length}`);

  // access-requests was retired (404s) — invites are the onboarding surface now.
  const invites = await req('GET', '/admin/invites', { token: adminT });
  ok(invites.status === 200 && Array.isArray(invites.json), 'GET /admin/invites (onboarding surface)', `n=${invites.json?.length}`);

  if (!evList.length) { info('no evaluated sessions to assign — cannot exercise the assign→score chain'); return finish(); }

  // ---- COUNCIL MAPPING: a cross-council assignment is rejected (409) ----
  // The assignee must belong to the PLE's council; assigning across councils is blocked. Pure CRUD —
  // the request is refused BEFORE any write, so this exercises the guard with zero data change.
  // (Matches backend/tests/admin-assign.test.js "cross-council auditor → 409".)
  console.log('C2) Council mapping — cross-council assignment is rejected');
  {
    const ple = evList[0]; // an evaluated PLE in the admin's own council
    const audRes = await req('GET', '/admin/users?role=auditor&status=active&limit=200', { token: saT }); // superadmin: all councils
    const auditorsAll = Array.isArray(audRes.json) ? audRes.json : [];
    const foreign = auditorsAll.find(u => u.council_id && ple?.council_id && u.council_id !== ple.council_id);
    if (!ple?.council_id) {
      info('cross-council — skipped (the evaluated PLE carries no council_id in this data)');
    } else if (!foreign) {
      info('cross-council — skipped (no active auditor in a council other than the evaluated PLEs’)');
    } else {
      const xc = await req('POST', `/admin/ples/${ple.id}/assign`, { token: adminT, body: { auditor_id: foreign.id } });
      ok(xc.status === 409 && /cross-council/i.test(xc.json?.error || ''),
         'cross-council assign rejected (409 Cross-council)',
         `status=${xc.status} · ${xc.json?.error ?? ''}`);
    }
  }

  // Assign evaluated sessions to our auditor until we find one they have NOT scored yet.
  console.log('D) Admin assigns → Auditor blind queue → score');
  let scorablePle = null, queueChecked = false;
  for (const ple of evList) {
    const asg = await req('POST', `/admin/ples/${ple.id}/assign`, { token: adminT, body: { auditor_id: auditorId } });
    if (asg.status !== 200) { info(`assign ${ple.id.slice(0,8)} → ${asg.status}`); continue; }
    const q = await req('GET', '/auditor/queue', { token: auT });
    queueChecked = true;
    const mine = (q.json ?? []).find(x => x.id === ple.id);
    if (mine && mine.scored === false) { scorablePle = ple.id; break; }
  }
  ok(queueChecked, 'POST /admin/ples/:id/assign accepted (status=evaluated gate)');

  // Re-fetch the queue for the blind-property assertion.
  const queue = await req('GET', '/auditor/queue', { token: auT });
  ok(queue.status === 200 && Array.isArray(queue.json) && queue.json.length >= 1, 'GET /auditor/queue (assigned work)', `n=${queue.json?.length}`);
  const qLeak = leaksIdentity(queue.json);
  ok(qLeak.length === 0, 'auditor queue is BLIND (no physician identity)', qLeak.length ? `LEAK: ${qLeak}` : 'session fields only');

  if (scorablePle) {
    const detail = await req('GET', `/auditor/ples/${scorablePle}`, { token: auT });
    const dLeak = leaksIdentity(detail.json?.ple);
    ok(detail.status === 200 && !!detail.json?.messages, 'GET /auditor/ples/:id (blind transcript)', `turns=${detail.json?.messages?.length}`);
    ok(dLeak.length === 0, 'auditor session detail is BLIND', dLeak.length ? `LEAK: ${dLeak}` : 'no identity fields');

    // Every pre-submit confirmation is required server-side, not only in the browser — an
    // assessment that reached the database without them is one the approved form says was never
    // completed. Omitting them here is a 400, which is the correct answer, not a passing score.
    const ATTESTATIONS = { all_domains_scored: true, comments_recorded: true, scored_independently: true,
      no_identifiers_found: true, weights_provisional: true };
    const score = await req('POST', `/auditor/ples/${scorablePle}/score`, { token: auT, body: { d1:4,d2:4,d3:3,d4:4,d5:4,d6:3,d7:4, notes: 'role-chain smoke (de-identified)', attestations: ATTESTATIONS } });
    // Scoring is gated on the auditor's confidentiality + COI consent. That consent is a CREC record
    // a person gives in the console; a smoke script must not manufacture one on their behalf. So a
    // 403 here is a PRECONDITION on the account, not a defect in the scoring path — say which.
    if (score.status === 403 && score.json?.code === 'auditor_consent_required') {
      info(`auditor ${AUDITOR.email} has not completed consent — scoring not exercised. `
         + 'Sign in as that auditor once and accept the confidentiality + COI consent, then re-run.');
    } else {
      ok(score.status === 200 && typeof score.json?.composite_score === 'number', 'POST /auditor/ples/:id/score',
         `status=${score.status} composite=${score.json?.composite_score}${score.json?.error ? ' err=' + JSON.stringify(score.json.error).slice(0,120) : ''}`);
    }
  } else {
    info('all assigned evaluated sessions already scored by this auditor — verifying the double-submit guard instead');
    const firstAssigned = (queue.json ?? [])[0];
    if (firstAssigned) {
      const dup = await req('POST', `/auditor/ples/${firstAssigned.id}/score`, { token: auT, body: { d1:4,d2:4,d3:3,d4:4,d5:4,d6:3,d7:4 } });
      ok(dup.status === 409, 'double-submit guard (409 Already scored)', `status=${dup.status}`);
    }
  }

  // ---- SUPERADMIN: score reaches ICC + export ----
  console.log('E) Superadmin — auditor score reaches ICC + export');
  const iccAfter = await req('GET', '/admin/icc', { token: saT });
  ok(iccAfter.status === 200 && (iccAfter.json?.n ?? 0) >= 1, 'GET /admin/icc has ≥1 AI↔auditor pair', `icc=${iccAfter.json?.icc ?? 'null'} n=${iccAfter.json?.n}`);

  const exp = await req('GET', '/admin/export', { token: saT });
  const auditorEntries = (exp.json?.sessions ?? []).flatMap(s => s.auditor_scores ?? []);
  ok(exp.status === 200, 'GET /admin/export', `sessions=${exp.json?.n}`);
  ok(auditorEntries.length >= 1, 'export contains ≥1 auditor score', `entries=${auditorEntries.length}`);
  // Two valid pseudonyms: an enrolled auditor exports under their experiment code (EXP-NNN), anyone
  // else under A-<hash>. The invariant is that the raw auditor_id never leaves, not which form it takes.
  const audOk = auditorEntries.every(a => !('auditor_id' in a) && /^(A-[0-9a-f]{8}|EXP-\d+)$/.test(a.auditor ?? ''));
  ok(auditorEntries.length === 0 || audOk, 'exported auditor scores pseudonymized (A-<hash> or EXP-NNN)',
     auditorEntries.length ? `sample=${auditorEntries[0]?.auditor}` : 'none');

  finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function finish() {
  console.log(`\n=== role-chain result: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}
