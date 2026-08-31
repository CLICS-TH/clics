#!/usr/bin/env node
/*
 * ICC calibration harness (G1 credit gate). Measures AI↔counterpart-rater ICC on the FIXED soak
 * cohort and reports per-domain divergence so the PIS-7 evaluator prompt can be tuned toward ≥0.75.
 *
 * !! The soak's three "auditors" were CLAUDE AGENTS with assigned rater stances, not humans —
 * !! see scripts/soak/gen-auditor-wf.js:30-32. Every ICC this script has ever produced is
 * !! therefore AI-vs-AI. No CLICS ICC has been measured against real human auditors yet, and
 * !! none of these numbers may be cited as human-validated agreement. The `human` identifiers
 * !! below are KEY NAMES ONLY, kept because runs/*.json, three-way.js and
 * !! GET /oversight/icc/three-way all consume that shape; renaming them would break those.
 *
 * Cohort = every PLE that has BOTH an ai_evaluations row AND ≥1 audit_scores row (the 2026-06-07
 * soak's 10 PLEs / 30 counterpart-rater scores). Read-only on the DB in backend/.env.
 *
 * Modes:
 *   --mode baseline   ICC from the STORED ai_evaluations (no Claude calls). Must reproduce ≈0.66 —
 *                     this is the harness's correctness check against the known soak result.
 *   --mode rescore    (default) re-score each transcript via RIMPL /evaluate (LIVE Claude), then
 *                     compute ICC of the NEW AI scores vs the same counterpart-rater scores.
 *
 * Run from backend/ (so dotenv loads backend/.env and NODE_PATH resolves @supabase/supabase-js):
 *   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/calibrate.js --mode baseline
 *   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/calibrate.js --mode rescore
 * (rescore also needs RIMPL running on RIMPL_URL with ANTHROPIC_API_KEY — see README.md.)
 *
 * CAVEATS (see README): tuning on the same 10 PLEs you measure on risks OVERFITTING; at n≈30 pairs
 * the 95% CI is wide (~0.40–0.83). A run hitting ≥0.75 here is necessary, NOT a passed gate.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { computeICC21 } = require('../../backend/src/services/icc');
const { rimplEvaluate } = require('../../backend/src/services/rimpl-client');
const { WEIGHTS } = require('../../backend/src/services/ple-gate');

const args = process.argv.slice(2);
const flagVal = (name) => {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const MODE = flagVal('mode') || 'rescore';
const GATE = 0.75;
const BASELINE_ICC = 0.662; // the 2026-06-07 soak pooled AI↔counterpart-rater result (agents, not humans)
const DOMS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const DOM_NAMES = { d1: 'ClinQ', d2: 'Reason', d3: 'Context', d4: 'Iterative', d5: 'Appraisal', d6: 'Reflect', d7: 'AILit' };

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (run from backend/ so backend/.env loads).');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const num = (x) => Number(x);
const pick = (e) => Object.fromEntries(DOMS.map(d => [d, num(e[d])]));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

async function loadCohort() {
  const { data: ai, error: e1 } = await supabase.from('ai_evaluations').select('ple_id, d1,d2,d3,d4,d5,d6,d7, composite_score');
  const { data: aud, error: e2 } = await supabase.from('audit_scores').select('ple_id, auditor_id, d1,d2,d3,d4,d5,d6,d7, composite_score');
  if (e1 || e2) throw new Error(`DB read failed: ${(e1 || e2).message}`);
  const aiBy = new Map((ai || []).map(e => [e.ple_id, e]));
  const audBy = new Map();
  for (const s of aud || []) { (audBy.get(s.ple_id) || audBy.set(s.ple_id, []).get(s.ple_id)).push(s); }
  const ids = [...aiBy.keys()].filter(id => audBy.has(id));
  const { data: ples } = ids.length ? await supabase.from('ples').select('id, physician_id').in('id', ids) : { data: [] };
  const physIds = [...new Set((ples || []).map(p => p.physician_id))];
  const { data: pros } = physIds.length ? await supabase.from('professionals').select('id, pseudonym').in('id', physIds) : { data: [] };
  const pseudo = new Map((pros || []).map(p => [p.id, p.pseudonym]));
  const label = new Map((ples || []).map(p => [p.id, pseudo.get(p.physician_id) || p.id.slice(0, 6)]));
  return ids.map(id => ({ ple_id: id, pseudonym: label.get(id) || id.slice(0, 6), ai: aiBy.get(id), humans: audBy.get(id) }));
}

async function fetchMessages(ple_id) {
  const { data } = await supabase.from('messages').select('role, content').eq('ple_id', ple_id).order('created_at');
  return (data || []).map(m => ({ role: m.role, content: m.content }));
}

function promptSha() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'rimpl', 'src', 'lib', 'prompts.js'), 'utf8');
    const m = src.match(/PIS7_EVALUATOR_PROMPT\s*=\s*`([\s\S]*?)`/);
    return crypto.createHash('sha256').update(m ? m[1] : src).digest('hex');
  } catch { return 'unknown'; }
}

// aiScoreOf: cohort entry -> { d1..d7, composite }
function buildReport(cohort, aiScoreOf) {
  const pairs = [];
  const perPle = [];
  for (const c of cohort) {
    const ai = aiScoreOf(c);
    const humanComposites = c.humans.map(h => num(h.composite_score));
    for (const h of humanComposites) pairs.push({ ai: num(ai.composite), human: h });
    const mh = mean(humanComposites);
    perPle.push({ pseudonym: c.pseudonym, ai: r1(num(ai.composite)), human: r1(mh), delta: r1(num(ai.composite) - mh), n_human: humanComposites.length });
  }
  const domain = {};
  for (const d of DOMS) {
    const aiMean = mean(cohort.map(c => num(aiScoreOf(c)[d])));
    const humanMean = mean(cohort.flatMap(c => c.humans.map(h => num(h[d]))));
    domain[d] = { name: DOM_NAMES[d], weight: WEIGHTS[d], ai: r2(aiMean), human: r2(humanMean), delta: r2(aiMean - humanMean) };
  }
  return { icc: computeICC21(pairs), pairCount: pairs.length, perPle, domain };
}

function printReport(mode, report, sha) {
  const { icc, domain, perPle, pairCount } = report;
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`ICC (AI↔rater, pooled): ${icc.icc}  [95% CI ${icc.lower}–${icc.upper}]  n=${pairCount}  → ${icc.interpretation}`);
  console.log(`Gate ≥ ${GATE}: ${icc.icc >= GATE ? 'MET on this set (NOT a passed gate — see caveats)' : `below by ${r2(GATE - icc.icc)}`}`);
  console.log(`vs 2026-06-07 baseline ${BASELINE_ICC}: ${icc.icc >= BASELINE_ICC ? '+' : ''}${r2(icc.icc - BASELINE_ICC)}`);
  console.log(`\nPer-domain mean (AI vs rater; +Δ = AI inflates):`);
  console.log(`  dom  name        w     AI    rater   Δ`);
  for (const d of DOMS) { const x = domain[d]; console.log(`  ${d}   ${x.name.padEnd(10)} ${x.weight.toFixed(2)}  ${String(x.ai).padStart(4)}  ${String(x.human).padStart(5)}  ${x.delta >= 0 ? '+' : ''}${x.delta}`); }
  console.log(`\nPer-PLE composite (AI vs mean rater score):`);
  for (const p of perPle) console.log(`  ${String(p.pseudonym).padEnd(8)} AI ${String(p.ai).padStart(5)}  rater ${String(p.human).padStart(5)}  Δ ${p.delta >= 0 ? '+' : ''}${p.delta}`);
  if (sha) console.log(`\nPIS-7 prompt sha256: ${sha.slice(0, 16)}`);
  console.log(`──────────────────────────────────────────────\n`);
}

function writeRun(mode, report, sha) {
  const dir = path.join(__dirname, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${mode}.json`);
  fs.writeFileSync(file, JSON.stringify({ stamp, mode, prompt_sha: sha, gate: GATE, baseline_icc: BASELINE_ICC, ...report }, null, 2));
  console.log(`Run archived → scripts/calibration/runs/${path.basename(file)}`);
}

(async () => {
  console.log(`\n=== CLICS ICC calibration — mode=${MODE} ===`);
  let cohort = await loadCohort();
  const totalHumans = cohort.reduce((a, c) => a + c.humans.length, 0);
  console.log(`Cohort: ${cohort.length} PLEs (AI eval + ≥1 rater score), ${totalHumans} rater scores.`);
  console.log('NOTE: the soak cohort\'s raters were Claude agents, not humans — this ICC is AI-vs-AI.');
  if (cohort.length < 2) {
    console.error('Not enough doubly-scored PLEs to compute ICC — is backend/.env pointing at the DB that holds the soak cohort?');
    process.exit(1);
  }

  let aiScoreOf, sha = null;
  if (MODE === 'baseline') {
    aiScoreOf = (c) => ({ ...pick(c.ai), composite: num(c.ai.composite_score) });
  } else if (MODE === 'rescore') {
    sha = promptSha();
    console.log(`Re-scoring via RIMPL ${process.env.RIMPL_URL || 'http://localhost:3003'} (live Claude). prompt sha=${sha.slice(0, 12)}\n`);
    // An eval is valid only if every domain is numeric (the model occasionally returns malformed
    // JSON, which would silently score 0 and poison the ICC) — retry once, else drop the PLE.
    const validEval = (e) => e && DOMS.every(d => Number.isFinite(Number(e[d]))) && Number(e.composite_score) > 0;
    const newMap = new Map();
    for (const c of cohort) {
      const messages = await fetchMessages(c.ple_id);
      try {
        // shadow:false — this harness re-scores the REAL cohort through RIMPL's /evaluate. Without
        // the opt-out every rescore would fire a shadow evaluation and overwrite that PLE's
        // accumulated pilot shadow row with a calibration-run row, destroying the paired corpus this
        // harness exists to measure. (Also: it re-scores without patient_ref, so the replacement
        // would not even be de-identified on the same terms.)
        let e = await rimplEvaluate({ ple_id: c.ple_id, transcript: messages, shadow: false });
        if (!validEval(e)) {
          console.log(`  ↻ ${String(c.pseudonym).padEnd(8)} invalid eval (missing domains) — retrying once`);
          e = await rimplEvaluate({ ple_id: c.ple_id, transcript: messages, shadow: false });
        }
        if (!validEval(e)) { console.error(`  ✗ ${String(c.pseudonym).padEnd(8)} invalid eval twice — dropped from this run`); continue; }
        newMap.set(c.ple_id, e);
        console.log(`  ✓ ${String(c.pseudonym).padEnd(8)} composite=${e.composite_score}`);
      } catch (err) {
        console.error(`  ✗ ${String(c.pseudonym).padEnd(8)} ${err.message}`);
      }
    }
    cohort = cohort.filter(c => newMap.has(c.ple_id));
    if (cohort.length < 2) { console.error('\nToo few successful re-scores — is RIMPL up and ANTHROPIC_API_KEY set?'); process.exit(1); }
    aiScoreOf = (c) => ({ ...pick(newMap.get(c.ple_id)), composite: num(newMap.get(c.ple_id).composite_score) });
  } else {
    console.error(`Unknown --mode "${MODE}" (use baseline|rescore).`); process.exit(1);
  }

  const report = buildReport(cohort, aiScoreOf);
  printReport(MODE, report, sha);
  writeRun(MODE, report, sha);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
