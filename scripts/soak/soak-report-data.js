// Assemble every number the superadmin review report needs.
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { WEIGHTS } = require('../../backend/src/services/cle-gate');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DOMAINS = ['d1','d2','d3','d4','d5','d6','d7'];
const round = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

(async () => {
  const { data: pros } = await s.from('professionals').select('id, pseudonym, role, full_name_en');
  const pseudo = Object.fromEntries(pros.map(p => [p.id, p.pseudonym || p.full_name_en]));
  const tiers = JSON.parse(fs.readFileSync('/tmp/soak-results.json', 'utf8'));
  const tierByEmail = {}; tiers.forEach(t => { tierByEmail[t.pseudonym] = t.tier; });

  // ---- CLE funnel ----
  const { data: ples } = await s.from('ples').select('id, physician_id, status, turn_count, token_count, duration_seconds, started_at').order('started_at');
  const funnel = ples.reduce((a, p) => { a[p.status] = (a[p.status]||0)+1; return a; }, {});
  console.log('=== CLE FUNNEL ===');
  console.log('total PLEs:', ples.length, JSON.stringify(funnel));

  // ---- evaluations + audit scores ----
  const { data: ai } = await s.from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  const aiBy = Object.fromEntries(ai.map(e => [e.ple_id, e]));
  const { data: scores } = await s.from('audit_scores').select('ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  const scoresByPle = {}; scores.forEach(sc => (scoresByPle[sc.ple_id] ??= []).push(sc));

  // ---- per-PLE AI vs mean-human ----
  console.log('\n=== PER-PLE: AI vs MEAN-HUMAN (evaluated) ===');
  const rows = [];
  for (const p of ples.filter(x => x.status === 'evaluated')) {
    const aiC = Number(aiBy[p.id]?.composite_score);
    const hs = (scoresByPle[p.id] || []).map(x => Number(x.composite_score));
    const meanH = hs.reduce((a,b)=>a+b,0)/hs.length;
    rows.push({ pseudonym: pseudo[p.physician_id], tier: tierByEmail[pseudo[p.physician_id]], ai: round(aiC), meanH: round(meanH), delta: round(aiC-meanH), hs: hs.map(x=>round(x)) });
  }
  rows.sort((a,b)=>a.ai-b.ai);
  for (const r of rows) console.log(`  ${r.pseudonym} ${String(r.tier).padEnd(8)} AI=${String(r.ai).padEnd(5)} human(mean)=${String(r.meanH).padEnd(5)} Δ=${String(r.delta).padStart(5)}  humans=[${r.hs.join(', ')}]`);
  const meanDelta = round(rows.reduce((a,r)=>a+r.delta,0)/rows.length);
  console.log(`  mean AI-minus-human delta: ${meanDelta}  (positive = AI scores higher than auditors)`);

  // ---- per-domain AI vs human mean (where do they diverge?) ----
  console.log('\n=== PER-DOMAIN mean (AI vs human), evaluated set ===');
  const domNames = { d1:'ClinQ', d2:'Reason', d3:'Context', d4:'Iterative', d5:'Appraisal', d6:'Reflect', d7:'AILit' };
  for (const d of DOMAINS) {
    const aiMean = round(ai.reduce((a,e)=>a+e[d],0)/ai.length, 2);
    const hMean = round(scores.reduce((a,e)=>a+e[d],0)/scores.length, 2);
    console.log(`  ${d} ${domNames[d].padEnd(10)} AI=${aiMean}  human=${hMean}  Δ=${round(aiMean-hMean,2)}  (w=${WEIGHTS[d]})`);
  }

  // ---- per-auditor mean composite (lenient/strict check) ----
  console.log('\n=== PER-AUDITOR mean composite (stance check) ===');
  const byAud = {}; scores.forEach(sc => (byAud[sc.auditor_id] ??= []).push(Number(sc.composite_score)));
  for (const [aid, arr] of Object.entries(byAud)) console.log(`  ${pseudo[aid]}  mean=${round(arr.reduce((a,b)=>a+b,0)/arr.length)}  n=${arr.length}`);

  // ---- LPDP trajectories (per physician, evaluated PLEs over time) ----
  console.log('\n=== LPDP trajectories (composite over the week) ===');
  const { data: lpdp } = await s.from('lpdp_snapshots').select('physician_id, composite_score, snapshot_at').order('snapshot_at');
  const traj = {}; lpdp.forEach(l => (traj[pseudo[l.physician_id]] ??= []).push(round(Number(l.composite_score))));
  for (const [ps, arr] of Object.entries(traj).sort()) console.log(`  ${ps}: ${arr.join(' -> ')}`);

  // ---- token usage vs 10k (from driver) ----
  console.log('\n=== TOKEN USAGE vs 10k budget (from driver) ===');
  for (const t of tiers) console.log(`  ${t.pseudonym} ${String(t.tier).padEnd(8)} spent=${String(t.spent).padEnd(6)} budget=${t.budget}  hit10k=${t.cross10kAt ? 'turn '+t.cross10kAt.turn : 'no'}`);

  fs.writeFileSync('/tmp/soak-report-numbers.json', JSON.stringify({ funnel, rows, meanDelta, traj }, null, 2));
  console.log('\nWrote /tmp/soak-report-numbers.json');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
