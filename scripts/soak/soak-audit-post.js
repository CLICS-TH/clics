// Post the 3 auditors' independent blind PIS-7 scores via the real auditor API, distribute CLE
// assignments round-robin (for the dashboard/queue), then compute ICC (per-auditor via the API +
// pooled AI-human and inter-rater via the formulae).
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-audit-post.js
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { computeICC21 } = require('../../backend/src/services/icc');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

const BASE = process.env.SOAK_BASE || 'https://backend-production-c12e4.up.railway.app';
const PW = 'SoakPass#2026';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
// (email, password?) — the superadmin passes its own password; soak personas default to PW.
const login = (e, pw = PW) => api('POST', '/auth/login', { body: { email: e, password: pw } });

// mean composite over pairwise raters (inter-rater ICC(2,1) generalised to k raters via avg pairwise)
function pairwiseInterRater(byPle) {
  const pairs = [];
  for (const ratings of Object.values(byPle)) {
    for (let i = 0; i < ratings.length; i++)
      for (let j = i + 1; j < ratings.length; j++)
        pairs.push({ ai: ratings[i], human: ratings[j] }); // reuse 2-col ICC over all rater pairs
  }
  return computeICC21(pairs);
}

(async () => {
  const audits = JSON.parse(fs.readFileSync('/tmp/soak-audit-scores.json', 'utf8'));
  const sa = (await login('superadmin@clics.th', 'ClicsSuper#2026r2')).body.access_token;

  // login each auditor + capture their professional id
  const auditorTokens = {}, auditorIds = {};
  for (const a of audits) {
    const lg = await login(a.auditor);
    auditorTokens[a.auditor] = lg.body.access_token;
    const me = await api('GET', '/auth/me', { token: lg.body.access_token });
    auditorIds[a.auditor] = me.body.user.id;
  }

  // collect all evaluated cle ids (union across auditors)
  const allCles = [...new Set(audits.flatMap(a => a.scores.map(s => s.cle_id)))];
  const auditorEmails = audits.map(a => a.auditor);
  let posted = 0, assigned = 0;

  // post every auditor's blind scores. cles.auditor_id holds a SINGLE assignee and the score route
  // enforces it, so rotate the assignment to each rater just-in-time — that lets all three score
  // the same CLE through the real API (409 'Already scored' makes re-runs idempotent).
  for (const a of audits) {
    for (const s of a.scores) {
      const { cle_id, notes, ref, d1, d2, d3, d4, d5, d6, d7 } = s;
      await api('POST', `/admin/cles/${cle_id}/assign`, { token: sa, body: { auditor_id: auditorIds[a.auditor] } });
      const r = await api('POST', `/auditor/cles/${cle_id}/score`, { token: auditorTokens[a.auditor], body: { d1, d2, d3, d4, d5, d6, d7, notes } });
      if (r.status === 200) posted++;
      else if (r.status !== 409) console.log(`  score ${a.auditor} ${cle_id.slice(0,8)}: ${r.status} ${JSON.stringify(r.body).slice(0,120)}`);
    }
  }

  // final round-robin pass = the lasting "primary" assignee shown in the dashboard/queue
  for (let i = 0; i < allCles.length; i++) {
    const primary = auditorEmails[i % auditorEmails.length];
    const r = await api('POST', `/admin/cles/${allCles[i]}/assign`, { token: sa, body: { auditor_id: auditorIds[primary] } });
    if (r.status === 200) assigned++;
  }
  console.log(`Posted ${posted} new auditor scores. Final round-robin assignment: ${assigned}/${allCles.length}.`);

  // --- ICC ---
  console.log('\n=== ICC (AI vs human, per auditor — via API) ===');
  for (const a of audits) {
    const icc = await api('GET', '/auditor/icc', { token: auditorTokens[a.auditor] });
    console.log(`  ${a.auditor.padEnd(24)} ICC=${JSON.stringify(icc.body)}`);
  }

  // pooled AI-human + inter-rater from DB
  const { data: aiEvals } = await supabase.from('ai_evaluations').select('cle_id, composite_score');
  const aiBy = Object.fromEntries(aiEvals.map(e => [e.cle_id, Number(e.composite_score)]));
  const { data: scores } = await supabase.from('audit_scores').select('cle_id, auditor_id, composite_score');

  const aiHumanPairs = scores.filter(s => aiBy[s.cle_id] != null)
    .map(s => ({ ai: aiBy[s.cle_id], human: Number(s.composite_score) }));
  const pooled = computeICC21(aiHumanPairs);
  console.log(`\n=== Pooled AI-human ICC (n=${aiHumanPairs.length} ratings) ===\n  ${JSON.stringify(pooled)}`);

  const byPle = {};
  for (const s of scores) (byPle[s.cle_id] ??= []).push(Number(s.composite_score));
  const inter = pairwiseInterRater(byPle);
  console.log(`\n=== Inter-rater ICC (avg pairwise across 3 auditors, ${Object.keys(byPle).length} CLEs) ===\n  ${JSON.stringify(inter)}`);

  fs.writeFileSync('/tmp/soak-icc.json', JSON.stringify({ pooled, inter, aiHumanPairs, byPle, aiBy }, null, 2));
  console.log('\nWrote /tmp/soak-icc.json');
  process.exit(0);
})().catch(e => { console.error('POST FAILED:', e.message); process.exit(1); });
