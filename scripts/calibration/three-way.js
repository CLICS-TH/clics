#!/usr/bin/env node
/*
 * Three-way PIS-7 evaluator comparison (offline decision harness).
 *
 * WHAT. CME credit is gated on AI-human agreement (ICC(2,1) >= 0.75). A candidate on-prem evaluator
 * now scores every PLE a SECOND time into `shadow_evaluations` -- never served, never shown. This
 * harness reads the three score sets off the DB and prints the three comparisons a model-swap
 * decision actually rests on:
 *
 *   claude-vs-auditor   the existing arm -- the only human-anchored ICC either model will ever have
 *   local-vs-auditor    the acceptance test for moving the evaluator on-prem
 *   claude-vs-local     a cheap early signal, and a correlated-error check
 *
 * THE AUDITORS ARE THE REFERENCE STANDARD. Claude is not. A high claude-vs-local ICC proves only
 * that the two models are SIMILAR -- possibly similarly wrong. Only the human-anchored arms can pass
 * a gate; claude-vs-local can only ever fail one early or flag correlated error.
 *
 * USABLE TODAY. `shadow_evaluations` may not exist yet (db/migration-shadow-evaluations.sql is
 * deliberately unapplied) and will be empty for a while after it does. Neither is an error: the
 * shadow arms report as unavailable and the claude-vs-auditor arm still runs, on the PLEs that
 * already carry both an AI and a human score. Running it now makes November a re-run, not a build.
 *
 * READ-ONLY. Like calibrate.js, this performs NO inserts/updates/upserts -- every DB call is a
 * .select(). It must stay that way: it reads the very corpus the decision depends on.
 *
 * Run from backend/ (so dotenv loads backend/.env and NODE_PATH resolves @supabase/supabase-js):
 *   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/three-way.js
 *
 * Flags:
 *   --include-test        include is_test PLEs (default: excluded, matching GET /oversight/icc)
 *   --provider <name>     pick the shadow candidate explicitly (default: most recent evaluated_at)
 *   --model <version>     ditto by model_version -- a provider is a TRANSPORT, not a candidate
 *   --margin <0.10>       pre-registered non-inferiority margin, local vs Claude (see README)
 *   --top <25|all>        how many per-PLE deltas to print (the archived JSON always holds all)
 *
 * MATCHES THE DASHBOARD. The estimator is backend/src/services/icc.js -- the same function
 * GET /oversight/icc/three-way calls -- and the cohort rules are the endpoint's: auditors averaged
 * to ONE human value per PLE before pairing, is_test excluded, all arms on the same PLEs, one
 * candidate per run. So `coverage` and the `arms` ICCs here should reproduce the endpoint's JSON.
 *
 * DIFFERS FROM calibrate.js ON PURPOSE. calibrate.js POOLS one pair per auditor (a 3-auditor PLE
 * contributes 3 pairs reusing one AI value), which inflates n; its 0.662 baseline is NOT comparable
 * to the numbers below. This averages first, as ICC(2,1) requires.
 *
 * CAVEATS: small n, wide CIs and the standing overfitting warning all apply -- see README.md.
 */

// dotenv is optional -- env may equally come from the shell. A missing dev dependency must never
// produce a stack trace in front of the "you have not configured a database" message.
try { require('dotenv').config(); } catch { /* ignore */ }

const fs = require('fs');
const path = require('path');
const iccLib = require('../../backend/src/services/icc');
const { WEIGHTS, compositeScore } = require('../../backend/src/services/ple-gate');

// The estimator is rater-symmetric, so one routine measures all three arms. Prefer the generic
// { a, b } entry point; fall back to the original { ai, human } spelling so this harness keeps
// working whichever of the two names the service exports.
const icc2 = typeof iccLib.iccTwoRater === 'function'
  ? iccLib.iccTwoRater
  : (pairs) => iccLib.computeICC21(pairs.map(p => ({ ai: p.a, human: p.b })));

// -- args --------------------------------------------------------------------
const args = process.argv.slice(2);
const flagVal = (name) => {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const INCLUDE_TEST = hasFlag('include-test') || flagVal('include-test') === 'true';
const WANT_PROVIDER = flagVal('provider');
const WANT_MODEL = flagVal('model');
const MARGIN = Number(flagVal('margin') ?? 0.10);
const TOP_RAW = flagVal('top');
const TOP = TOP_RAW === 'all' ? Infinity : Number(TOP_RAW ?? 25);

const ICC_GATE = 0.75;      // G1 credit gate
const CONTRACT_MIN = 0.95;  // a candidate must emit a valid score set at least this often
const DOMS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const DOM_NAMES = { d1: 'ClinQ', d2: 'Reason', d3: 'Context', d4: 'Iterative', d5: 'Appraisal', d6: 'Reflect', d7: 'AILit' };

const RATER = { ai: 'Claude', human: 'Auditor', shadow: 'Local' };
const ARMS = [
  { key: 'ai_vs_human', a: 'ai', b: 'human', title: 'Claude vs Auditor', note: 'the credit gate - human-anchored' },
  { key: 'shadow_vs_human', a: 'shadow', b: 'human', title: 'Local vs Auditor', note: 'the on-prem acceptance test - human-anchored' },
  { key: 'ai_vs_shadow', a: 'ai', b: 'shadow', title: 'Claude vs Local', note: 'similarity only - NOT validation; both can be wrong together' },
];

function die(lines) {
  console.error(`\n${Array.isArray(lines) ? lines.join('\n') : lines}\n`);
  process.exit(1);
}

// -- env ---------------------------------------------------------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  die([
    'Not configured - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset, so there is no database',
    'to read. Nothing was queried.',
    '',
    'Run it from backend/ so backend/.env loads and @supabase/supabase-js resolves:',
    '  cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/three-way.js',
  ]);
}

let createClient;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch {
  die([
    'Cannot resolve @supabase/supabase-js. Run from backend/ with NODE_PATH set:',
    '  cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/three-way.js',
  ]);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// -- helpers -----------------------------------------------------------------
const num = (x) => Number(x);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? ' n/a ' : x.toFixed(3));
// ' .. ' rather than a dash: an interval whose lower bound is negative must not read as a subtraction.
const ci = (r) => `[${f3(r.lower)} .. ${f3(r.upper)}]`;
const signed = (x, dp = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// PostgREST caps a select at 1000 rows. Silent truncation would corrupt every number below, so page
// explicitly, ordered by the primary key (every table read here has a uuid `id`).
const PAGE = 1000;
function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === 'PGRST205' || code === 'PGRST106' || code === '42P01') return true;
  const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table') || msg.includes('schema cache');
}
async function selectAll(table, cols, { optional = false } = {}) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(cols)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) {
      // A deliberately unapplied migration is a KNOWN state, not a fault -- degrade, never crash.
      if (optional && isMissingRelation(error)) return null;
      throw new Error(`read ${table} failed: ${error.message}`);
    }
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}
async function selectIn(table, cols, ids, key = 'id') {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from(table).select(cols).in(key, ids.slice(i, i + 200));
    if (error) throw new Error(`read ${table} failed: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

// -- arm computation ---------------------------------------------------------
// Returns null when the pair shares no PLEs. icc2 itself returns null below n=2 and an
// 'Insufficient variance' result when every score is identical -- both are surfaced, not hidden.
function buildArm(ids, A, B, labelOf, auditorCount) {
  const rows = ids.filter(id => A.has(id) && B.has(id)).map(id => ({ id, a: A.get(id), b: B.get(id) }));
  if (!rows.length) return null;

  const overall = icc2(rows.map(r => ({ a: r.a.composite, b: r.b.composite })));
  const per_domain = {};
  const bias_per_domain = {};
  for (const d of DOMS) {
    per_domain[d] = icc2(rows.map(r => ({ a: r.a[d], b: r.b[d] })));
    bias_per_domain[d] = r2(mean(rows.map(r => r.a[d])) - mean(rows.map(r => r.b[d])));
  }

  // Bias is the other half of the answer. ICC can be respectable while one rater sits a full band
  // above the other (the v0 evaluator ran +16.4 composite lenient), and a lenient evaluator hands
  // out credit that was not earned -- so agreement alone never settles it.
  const deltas = rows.map(r => r.a.composite - r.b.composite);
  const bias = mean(deltas);
  const sd = rows.length > 1
    ? Math.sqrt(deltas.reduce((s, x) => s + (x - bias) ** 2, 0) / (rows.length - 1))
    : 0;

  const per_cle = rows
    .map((r, i) => ({
      ple_id: r.id,
      label: labelOf(r.id),
      a: r1(r.a.composite),
      b: r1(r.b.composite),
      delta: r1(deltas[i]),
      n_auditors: auditorCount.get(r.id) ?? null,
      outlier: sd > 0 && Math.abs(deltas[i] - bias) > 2 * sd,
    }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return { overall, per_domain, n: rows.length, mean_bias: r2(bias), bias_sd: r2(sd), bias_per_domain, per_cle };
}

// -- printing ----------------------------------------------------------------
const RULE = '-'.repeat(78);

function fmtIcc(res) {
  if (!res) return 'n/a (needs >= 2 paired PLEs)';
  if (res.icc === null) return `n/a  n=${res.n}  ${res.interpretation}`;
  return `${f3(res.icc)}  95% CI ${ci(res)}  n=${res.n}  -> ${res.interpretation}`;
}

function printArm(spec, armCommon, armOwn, cohortNote) {
  const A = RATER[spec.a];
  const B = RATER[spec.b];
  console.log(`\n${RULE}`);
  console.log(`ARM  ${spec.title}   (${spec.note})`);
  console.log(RULE);
  if (!armCommon && !armOwn) {
    console.log(`  unavailable - no PLE carries both scores (${A} and ${B}).`);
    return;
  }
  const arm = armCommon || armOwn;
  console.log(`  cohort: ${cohortNote}`);
  console.log(`  ICC(2,1) ${A}-${B}: ${fmtIcc(arm.overall)}`);
  if (armOwn && armCommon && armOwn.n !== armCommon.n) {
    console.log(`  this arm alone, on all ${plural(armOwn.n, 'PLE')} it can pair: ${fmtIcc(armOwn.overall)}`);
    console.log(`    (not comparable across arms - shown so no data is silently dropped)`);
  }

  const lenient = arm.mean_bias >= 0 ? A : B;
  const verdict = Math.abs(arm.mean_bias) < 0.5
    ? 'no material leniency gap'
    : `${lenient} is more lenient by ${Math.abs(arm.mean_bias).toFixed(2)} composite pts`;
  console.log(`  mean bias: ${signed(arm.mean_bias)} (${A} - ${B}), SD ${arm.bias_sd}  ->  ${verdict}`);

  console.log(`\n  per-domain (0-5 scale; bias = ${A} - ${B}, + means ${A} scores higher):`);
  console.log(`    dom  ${'name'.padEnd(11)}${'w'.padEnd(6)}${'ICC'.padStart(6)}  ${'95% CI'.padEnd(18)}bias`);
  for (const d of DOMS) {
    const r = arm.per_domain[d];
    const interval = r && r.icc !== null ? ci(r) : (r ? `(${r.interpretation})` : '(n < 2)');
    const val = r && r.icc !== null ? f3(r.icc) : ' n/a ';
    console.log(`    ${d}   ${DOM_NAMES[d].padEnd(10)} ${WEIGHTS[d].toFixed(2)}  ${val.padStart(6)}  ${interval.padEnd(18)}${signed(arm.bias_per_domain[d])}`);
  }

  const shown = arm.per_cle.slice(0, TOP);
  console.log(`\n  per-PLE composite deltas, sorted by |delta|  (** = beyond 2 SD from this arm's bias):`);
  console.log(`    ${'PLE'.padEnd(15)} ${A.padStart(7)}  ${B.padStart(7)}  ${'delta'.padStart(7)}`);
  for (const p of shown) {
    const aud = (spec.a === 'human' || spec.b === 'human') && p.n_auditors
      ? `  (${p.n_auditors} auditor${p.n_auditors === 1 ? '' : 's'})` : '';
    console.log(`    ${String(p.label).padEnd(15)} ${String(p.a).padStart(7)}  ${String(p.b).padStart(7)}  ${signed(p.delta, 1).padStart(7)}${p.outlier ? '  **' : '    '}${aud}`);
  }
  if (arm.per_cle.length > shown.length) {
    console.log(`    ... ${arm.per_cle.length - shown.length} more - all are in the archived JSON; --top all prints them here`);
  }
}

// -- main --------------------------------------------------------------------
(async () => {
  const host = (() => { try { return new URL(process.env.SUPABASE_URL).host; } catch { return 'unknown-host'; } })();
  console.log(`\n=== CLICS three-way evaluator comparison ===`);
  console.log(`db=${host}  include_test=${INCLUDE_TEST}  non-inferiority margin=${MARGIN.toFixed(2)}`);

  const [aiRows, auditRows] = await Promise.all([
    selectAll('ai_evaluations', 'id, ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7'),
    selectAll('audit_scores', 'id, ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7'),
  ]);
  const shadowRows = await selectAll(
    'shadow_evaluations',
    'id, ple_id, provider, model_version, composite_score, d1,d2,d3,d4,d5,d6,d7, error, stop_reason, evaluated_at',
    { optional: true },
  );
  const shadowTableMissing = shadowRows === null;

  // is_test PLEs are excluded by default, matching GET /oversight/icc.
  const unionIds = [...new Set([
    ...aiRows.map(r => r.ple_id),
    ...auditRows.map(r => r.ple_id),
    ...(shadowRows || []).map(r => r.ple_id),
  ])];
  const pleRows = unionIds.length ? await selectIn('ples', 'id, is_test, physician_id', unionIds) : [];
  const pleById = new Map(pleRows.map(c => [c.id, c]));
  const allowed = new Set(pleRows.filter(c => INCLUDE_TEST || !c.is_test).map(c => c.id));

  const physIds = [...new Set(pleRows.map(c => c.physician_id).filter(Boolean))];
  const pros = physIds.length ? await selectIn('professionals', 'id, pseudonym', physIds) : [];
  const pseudoOf = new Map(pros.map(p => [p.id, p.pseudonym]));
  // A physician owns several PLEs, so the pseudonym alone is not a unique row label -- suffix the PLE
  // id so an outlier printed here can actually be looked up afterwards.
  const labelOf = (id) => `${pseudoOf.get(pleById.get(id)?.physician_id) || 'P-???'}/${id.slice(0, 6)}`;

  const finiteDoms = (o) => DOMS.every(d => Number.isFinite(num(o[d])));
  const toScore = (o) => {
    const doms = Object.fromEntries(DOMS.map(d => [d, num(o[d])]));
    const stored = num(o.composite_score);
    // shadow_evaluations.composite_score is nullable; recompute from the domains on the shared PIS-7
    // weights rather than dropping an otherwise valid score set.
    return { ...doms, composite: Number.isFinite(stored) ? stored : compositeScore(doms) };
  };

  // Claude (served) -- unique(ple_id), so one row per PLE.
  const ai = new Map();
  for (const r of aiRows) if (allowed.has(r.ple_id) && finiteDoms(r)) ai.set(r.ple_id, toScore(r));

  // Auditors -- averaged to ONE human value per PLE BEFORE pairing. ICC(2,1) assumes one rating per
  // subject per rater; a 3-auditor PLE contributing 3 pairs that reuse the same AI value inflates n
  // and distorts the estimate. With a single auditor the mean is that score, so both cases are right.
  const byCleAudit = new Map();
  for (const r of auditRows) {
    if (!allowed.has(r.ple_id)) continue;
    if (!byCleAudit.has(r.ple_id)) byCleAudit.set(r.ple_id, []);
    byCleAudit.get(r.ple_id).push(r);
  }
  const human = new Map();
  const auditorCount = new Map();
  for (const [id, rows] of byCleAudit) {
    const m = (k) => rows.reduce((s, r) => s + num(r[k]), 0) / rows.length;
    human.set(id, { ...Object.fromEntries(DOMS.map(d => [d, m(d)])), composite: m('composite_score') });
    auditorCount.set(id, rows.length);
  }

  // The AUDITED universe: PLEs carrying at least one auditor score. Same scope the endpoint reports
  // its coverage funnel over (human -> +ai -> +shadow -> all three), so the two agree.
  const auditedIds = [...human.keys()];
  const auditedSet = new Set(auditedIds);

  // Local (shadow candidate). `provider` is the TRANSPORT ('local'); the candidate is the PAIR
  // (provider, model_version). Pooling two candidates into one arm reports a number describing
  // neither, so group on the pair and measure exactly one -- the most recent, as the endpoint does.
  const shadowScoped = (shadowRows || []).filter(r => allowed.has(r.ple_id));
  const groups = new Map();
  for (const r of shadowScoped) {
    const key = `${r.provider} ${r.model_version}`;
    const g = groups.get(key) ?? { provider: r.provider, model_version: r.model_version, rows: [], latest: 0, audited: 0 };
    g.rows.push(r);
    g.latest = Math.max(g.latest, Date.parse(r.evaluated_at ?? '') || 0);
    if (auditedSet.has(r.ple_id)) g.audited += 1;
    groups.set(key, g);
  }
  const byRecency = (x, y) => (y.latest - x.latest)
    || String(y.model_version ?? '').localeCompare(String(x.model_version ?? ''));
  const allGroups = [...groups.values()].sort(byRecency);

  let candidate = null;
  if (WANT_PROVIDER || WANT_MODEL) {
    candidate = allGroups.find(g =>
      (!WANT_PROVIDER || g.provider === WANT_PROVIDER) && (!WANT_MODEL || g.model_version === WANT_MODEL)) || null;
    if (!candidate) {
      console.log(`\n! no shadow rows match --provider=${WANT_PROVIDER ?? '*'} --model=${WANT_MODEL ?? '*'} - shadow arms will be unavailable.`);
      if (allGroups.length) console.log(`  available: ${allGroups.map(g => `${g.provider}/${g.model_version} (${g.rows.length} rows)`).join(', ')}`);
    }
  } else {
    // Prefer the most recent candidate that actually overlaps the audited universe -- a newer
    // candidate seen only on unaudited PLEs cannot produce a human-anchored arm. Fall back to the
    // most recent overall so the coverage lines still name something.
    candidate = allGroups.find(g => g.audited > 0) || allGroups[0] || null;
  }
  if (allGroups.length > 1) {
    console.log(`\nShadow candidates present (${allGroups.length}) - measuring the marked one; --provider/--model to switch:`);
    for (const g of allGroups) {
      console.log(`  ${g === candidate ? '->' : '  '} ${g.provider}/${g.model_version}  ${plural(g.rows.length, 'row')}, ${g.audited} on audited PLEs`);
    }
  }

  // A row with a non-null `error` carries NO scores (constraint shadow_scored_xor_failed). It is
  // EXCLUDED from every ICC and COUNTED as a contract failure -- "the candidate could not produce a
  // valid score set 8% of the time" is a first-class, potentially disqualifying result, and
  // averaging it away would hide exactly the thing a model swap turns on.
  const shadow = new Map();
  let corpusScored = 0;
  let corpusFailed = 0;
  let auditedFailed = 0;
  for (const r of (candidate?.rows || [])) {
    const failed = r.error != null || !finiteDoms(r);
    if (failed) {
      corpusFailed += 1;
      if (auditedSet.has(r.ple_id)) auditedFailed += 1;
      continue;
    }
    corpusScored += 1;
    shadow.set(r.ple_id, toScore(r));
  }

  const withAi = auditedIds.filter(id => ai.has(id));
  const allThree = withAi.filter(id => shadow.has(id));
  const shadowAvailable = !shadowTableMissing && allThree.length > 0;
  // Arms are all computed on the SAME PLEs so they can honestly be read against one another. With no
  // shadow corpus that set degrades to human-and-ai and ai_vs_human matches GET /oversight/icc.
  const compareIds = shadowAvailable ? allThree : withAi;
  const ownIds = [...new Set([...auditedIds, ...ai.keys(), ...shadow.keys()])];

  const auditedShadowScored = auditedIds.filter(id => shadow.has(id)).length;
  const auditedAttempts = auditedShadowScored + auditedFailed;
  const corpusAttempts = corpusScored + corpusFailed;
  // Cohort-scoped rate (comparable to the endpoint's) and corpus-wide rate (the better estimate:
  // contract compliance is a property of the MODEL, not of whichever PLEs happened to be audited).
  const cohortRate = auditedAttempts ? auditedShadowScored / auditedAttempts : null;
  const corpusRate = corpusAttempts ? corpusScored / corpusAttempts : null;

  const coverage = {
    ples_with_human: human.size,
    ples_with_ai: withAi.length,
    ples_with_shadow: auditedShadowScored,
    ples_all_three: allThree.length,
    shadow_failed: auditedFailed,
    shadow_contract_rate: cohortRate === null ? null : r3(cohortRate),
  };

  const raters = { ai, human, shadow };
  const armOn = (ids, spec) => buildArm(ids, raters[spec.a], raters[spec.b], labelOf, auditorCount);
  const arms = {};
  const armsOwn = {};
  for (const spec of ARMS) {
    const usesShadow = spec.a === 'shadow' || spec.b === 'shadow';
    arms[spec.key] = usesShadow && !shadowAvailable ? null : armOn(compareIds, spec);
    armsOwn[spec.key] = usesShadow && !shadowAvailable ? null : armOn(ownIds, spec);
  }

  // -- report --
  console.log(`\n${RULE}`);
  console.log('COVERAGE  (audited universe = PLEs with at least one auditor score)');
  console.log(RULE);
  console.log(`  PLEs with >=1 auditor score (human) : ${coverage.ples_with_human}`);
  console.log(`  ... of those, with a Claude score   : ${coverage.ples_with_ai}`);
  console.log(`  ... of those, with a Local score    : ${coverage.ples_with_shadow}`
    + (shadowTableMissing ? '   [shadow_evaluations does not exist - migration not applied]'
      : !shadowScoped.length ? '   [table exists, no rows yet]' : ''));
  console.log(`  PLEs with all three                 : ${coverage.ples_all_three}`);
  console.log(`  shadow contract failures (audited)  : ${auditedAttempts ? `${coverage.shadow_failed} of ${auditedAttempts} attempt(s)` : 'none - no shadow attempts on audited PLEs'}`);
  console.log(`  shadow contract rate (audited)      : ${cohortRate === null ? 'n/a - no shadow attempts' : pct(cohortRate)}`);
  console.log(`  shadow contract rate (whole corpus) : ${corpusRate === null ? 'n/a - no shadow attempts' : `${pct(corpusRate)}  (${corpusScored}/${corpusAttempts})   need >= ${pct(CONTRACT_MIN)}`}`);
  if (corpusRate !== null && corpusAttempts !== auditedAttempts) {
    console.log(`    (the corpus rate is the better estimate of contract compliance - it is a property`);
    console.log(`     of the MODEL, not of whichever PLEs happened to be picked for audit)`);
  }
  console.log(`\n  Reference standard = the HUMAN AUDITORS. Claude is a comparator, not ground truth.`);

  const cohortNote = shadowAvailable
    ? `${plural(compareIds.length, 'PLE')} scored by all three - the arms below are directly comparable`
    : `${plural(compareIds.length, 'PLE')} with both a Claude and a human score (no shadow corpus yet)`;
  for (const spec of ARMS) printArm(spec, arms[spec.key], armsOwn[spec.key], cohortNote);

  // -- acceptance --
  const localHuman = arms.shadow_vs_human?.overall ?? null;
  const claudeHuman = arms.ai_vs_human?.overall ?? null;
  const mark = (ok) => (ok === null ? '[PENDING]' : ok ? '[ PASS  ]' : '[ FAIL  ]');

  const contractOk = corpusRate === null ? null : corpusRate >= CONTRACT_MIN;
  const iccOk = localHuman?.icc == null ? null : localHuman.icc >= ICC_GATE;
  const gap = (localHuman?.icc == null || claudeHuman?.icc == null) ? null : localHuman.icc - claudeHuman.icc;
  const nonInfOk = gap === null ? null : gap >= -MARGIN;

  console.log(`\n${RULE}`);
  console.log('ACCEPTANCE - moving the evaluator on-prem');
  console.log(RULE);
  const crit = (ok, label, value) => console.log(`  ${mark(ok)} ${label.padEnd(34)}: ${value}`);
  crit(contractOk, `contract compliance >= ${pct(CONTRACT_MIN)}`,
    corpusRate === null ? 'no shadow attempts yet' : `${pct(corpusRate)} (${corpusScored}/${corpusAttempts})`);
  crit(iccOk, `local-auditor ICC >= ${ICC_GATE.toFixed(2)}`,
    localHuman ? fmtIcc(localHuman) : 'no shadow data yet');
  crit(nonInfOk, `local within ${MARGIN.toFixed(2)} ICC of Claude`,
    gap === null ? 'not evaluable yet'
      : `delta ${signed(gap, 3)}  (local ${f3(localHuman.icc)} vs Claude ${f3(claudeHuman.icc)} on the same ${plural(compareIds.length, 'PLE')})`);
  console.log('');
  console.log(`  All three must hold. The first two are human-anchored; Claude-vs-Local is NOT`);
  console.log(`  acceptance evidence - two models can agree closely and both be lenient.`);
  console.log(`  POWER: at n~135 a ~0.10 ICC gap is detectable; 0.80 vs 0.78 is NOT. Pre-register the`);
  console.log(`  margin (--margin, default ${MARGIN.toFixed(2)}) BEFORE seeing these numbers, or the threshold ends`);
  console.log(`  up chosen to fit the result. A pass here is a directional signal, not a passed gate.`);
  console.log(`${RULE}\n`);

  // -- archive --
  // Same shape as GET /oversight/icc/three-way (arms / coverage / shadow) so an offline run and the
  // dashboard can be diffed directly, plus the bias and per-PLE detail the endpoint does not carry.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-three-way.json`);
  fs.writeFileSync(file, JSON.stringify({
    stamp,
    mode: 'three-way',
    db_host: host,
    include_test: INCLUDE_TEST,
    gates: { icc_gate: ICC_GATE, contract_min: CONTRACT_MIN, non_inferiority_margin: MARGIN },
    shadow: {
      available: shadowAvailable,
      table_present: !shadowTableMissing,
      provider: candidate?.provider ?? null,
      model_version: candidate?.model_version ?? null,
      candidates: allGroups.map(g => ({ provider: g.provider, model_version: g.model_version, rows: g.rows.length, on_audited_cles: g.audited })),
    },
    coverage,
    corpus: {
      shadow_scored: corpusScored,
      shadow_failed: corpusFailed,
      shadow_contract_rate: corpusRate === null ? null : r3(corpusRate),
    },
    common_cohort_n: compareIds.length,
    arms,
    arms_own_cohort: armsOwn,
    acceptance: {
      contract_compliance: contractOk,
      local_vs_human_icc: iccOk,
      non_inferior_to_claude: nonInfOk,
      icc_gap_local_minus_claude: gap === null ? null : r3(gap),
    },
  }, null, 2));
  console.log(`Run archived -> scripts/calibration/runs/${path.basename(file)}\n`);
})().catch(e => {
  console.error(`\nFATAL: ${e?.message || e}\n`);
  process.exit(1);
});
