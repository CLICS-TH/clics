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
 * A FOURTH, SEPARATE SECTION: local-vs-auditor with NO Claude row required. The three arms above
 * are deliberately computed on ONE common cohort (all three scores present), which is right for
 * reading them against each other -- but it means a PLE that never had a served Claude evaluation
 * can never reach the local-vs-auditor arm. The anchor PLEs imported into SANDBOX
 * (anchors/import-sandbox.mjs + import-shadow.mjs) are exactly that: auditor + shadow scores, and
 * deliberately no ai_evaluations row. So "Local vs Auditor (no Claude row required)" pairs every
 * PLE in the cohort carrying a shadow score and >=1 auditor score, with its OWN n, printed after
 * the three arms and archived as `local_vs_auditor_no_claude`. It is NOT an acceptance input and
 * changes nothing above it: the three arms, the coverage funnel and the gates are computed exactly
 * as before. Its prompt/rubric versions are printed and archived, with a warning on a mixture. For
 * the anchors: --include-test --manifest anchors/imports/sandbox-heldout.json --provider local
 * --model '<served model label>+anchor-median3' (import-shadow.mjs gives anchor rows their own
 * model_version so they never pool with live shadow traffic).
 *
 * USABLE TODAY. `shadow_evaluations` may not exist yet (db/migration-shadow-evaluations.sql is
 * deliberately unapplied) and will be empty for a while after it does. Neither is an error: the
 * shadow arms report as unavailable and the claude-vs-auditor arm still runs, on the PLEs that
 * already carry both an AI and a human score. Running it now makes November a re-run, not a build.
 *
 * READ-ONLY. Like calibrate.js, this performs NO inserts/updates/upserts -- every DB call is a
 * .select(). It must stay that way: it reads the very corpus the decision depends on. (The anchor
 * import scripts that WRITE the SANDBOX rows it can read live in anchors/, dry-run by default.)
 *
 * Run from backend/ (so dotenv loads backend/.env and NODE_PATH resolves @supabase/supabase-js):
 *   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/three-way.js
 *
 * Flags:
 *   --include-test        include is_test PLEs (default: excluded, matching GET /oversight/icc)
 *   --provider <name>     pick the shadow candidate explicitly (default: most recent evaluated_at)
 *   --model <version>     ditto by model_version -- a provider is a TRANSPORT, not a candidate
 *   --shadow-prompt <v>   ditto by the SHADOW row's prompt_version ('unrecorded' = a null one). The
 *                         candidate is (provider, model_version, prompt_version), as in
 *                         backend/src/services/agreement.js: two local addenda are two instruments,
 *                         never one pooled arm. Not the same flag as --prompt, which filters the
 *                         served ai_evaluations rows (the Claude arm).
 *   --margin <0.10>       pre-registered non-inferiority margin, local vs Claude (see README)
 *   --top <25|all>        how many per-PLE deltas to print (the archived JSON always holds all)
 *
 * SCOPING A G0.5 RUN. Without these three the harness reads whatever the database happens to hold,
 * which pools scores across prompt versions and mixes simulated soak raters in with real people --
 * and a G0.5 baseline computed over that mixture is not a baseline of anything.
 *
 *   --manifest <file.json>  restrict to a named PLE set. Array of ids, or { "ple_ids": [...] }.
 *                           HARD-ERRORS on an id the database does not have, rather than quietly
 *                           shrinking the cohort -- silent shrinkage is how survivorship bias got
 *                           into the earlier figures. The file's sha256 is printed and archived, so
 *                           a reported number names the cohort it came from.
 *   --prompt <version>      keep only ai_evaluations rows with this prompt_version. With or without
 *                           it, the versions present are always reported and MIXING IS WARNED ON:
 *                           ICC is a property of (model x prompt x rubric).
 *   --raters <ids|file>     keep only these auditors -- comma-separated ids/exp_codes, or a file of
 *                           them. This is the human-source filter: production carries ~30 audit rows
 *                           posted by simulated agent-raters through the real API, and nothing in
 *                           the row itself says so.
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
// The shadow candidate's prompt. 'unrecorded' selects the null-prompt group, the same sentinel
// --prompt and the version lists use. Kept apart from WANT_PROMPT on purpose: --prompt scopes the
// served (Claude) rows, this picks the local instrument.
const WANT_SHADOW_PROMPT_RAW = flagVal('shadow-prompt');
const WANT_SHADOW_PROMPT = WANT_SHADOW_PROMPT_RAW === 'unrecorded' ? null : WANT_SHADOW_PROMPT_RAW;
const PICK_SHADOW_PROMPT = WANT_SHADOW_PROMPT_RAW != null;
const MARGIN = Number(flagVal('margin') ?? 0.10);
const TOP_RAW = flagVal('top');
const TOP = TOP_RAW === 'all' ? Infinity : Number(TOP_RAW ?? 25);

// -- cohort scope (see "SCOPING A G0.5 RUN" above) ----------------------------
const crypto = require('crypto');
const MANIFEST_PATH = flagVal('manifest');
const WANT_PROMPT = flagVal('prompt');
const RATERS_RAW = flagVal('raters');

// Fail loudly on a malformed manifest. A run scoped to a file nobody can parse is worse than an
// unscoped one, because the output still looks scoped.
function loadManifest(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.error(`\n  FAIL: cannot read --manifest ${file} - ${e.message}\n`); process.exit(1); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { console.error(`\n  FAIL: --manifest ${file} is not valid JSON - ${e.message}\n`); process.exit(1); }
  const ids = Array.isArray(parsed) ? parsed : parsed?.ple_ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every(v => typeof v === 'string' && v.trim())) {
    console.error(`\n  FAIL: --manifest ${file} must be an array of PLE ids, or { "ple_ids": [...] }\n`);
    process.exit(1);
  }
  const uniq = [...new Set(ids.map(v => v.trim()))];
  if (uniq.length !== ids.length) {
    console.error(`\n  FAIL: --manifest ${file} lists ${ids.length - uniq.length} duplicate id(s). A PLE counted twice weights that episode twice.\n`);
    process.exit(1);
  }
  return { ids: uniq, sha256: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16), file };
}

// Comma-separated list, or a file holding one per line / a JSON array.
function loadRaters(raw) {
  let text = raw;
  if (fs.existsSync(raw)) {
    try { text = fs.readFileSync(raw, 'utf8'); }
    catch (e) { console.error(`\n  FAIL: cannot read --raters ${raw} - ${e.message}\n`); process.exit(1); }
    try { const j = JSON.parse(text); if (Array.isArray(j)) text = j.join(','); } catch { /* plain text */ }
  }
  const list = [...new Set(text.split(/[\s,]+/).map(v => v.trim()).filter(Boolean))];
  if (!list.length) { console.error(`\n  FAIL: --raters produced an empty list\n`); process.exit(1); }
  return list;
}

const MANIFEST = MANIFEST_PATH ? loadManifest(MANIFEST_PATH) : null;
const RATERS = RATERS_RAW ? loadRaters(RATERS_RAW) : null;

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
// Separate from ARMS on purpose: its cohort is NOT the common one, so it must never be read
// side by side with the three above or feed the acceptance gates.
const NO_CLAUDE_ARM = { key: 'local_vs_auditor_no_claude', a: 'shadow', b: 'human',
  title: 'Local vs Auditor (no Claude row required)', note: 'own cohort - NOT comparable with the arms above, NOT an acceptance input' };

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
  if (MANIFEST) console.log(`manifest=${MANIFEST.file}  ids=${MANIFEST.ids.length}  sha256=${MANIFEST.sha256}`);
  if (WANT_PROMPT) console.log(`prompt=${WANT_PROMPT}`);
  if (RATERS) console.log(`raters=${RATERS.length} named (human-source filter ON)`);
  if (!MANIFEST && !RATERS) {
    console.log(`scope=WHOLE DATABASE - not a G0.5 baseline. See --manifest / --raters above.`);
  }

  let [aiRows, auditRows] = await Promise.all([
    selectAll('ai_evaluations', 'id, ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7, prompt_version, model_version'),
    selectAll('audit_scores', 'id, ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7'),
  ]);
  const shadowRows = await selectAll(
    'shadow_evaluations',
    'id, ple_id, provider, model_version, prompt_version, rubric_version, composite_score, d1,d2,d3,d4,d5,d6,d7, error, stop_reason, evaluated_at',
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
  let allowed = new Set(pleRows.filter(c => INCLUDE_TEST || !c.is_test).map(c => c.id));
  // The cohort BEFORE --manifest narrows it. The shadow contract rate is printed as "whole corpus"
  // and is an acceptance gate in its own right; it is a property of the MODEL, so it must not move
  // when the reported cohort does. Without this, a manifest of 5 clean PLEs prints 100% (5/5) and
  // PASSES a gate the candidate fails corpus-wide.
  const corpusAllowed = new Set(allowed);

  // --- cohort scope -----------------------------------------------------------------------------
  // Applied HERE, once, before any arm is measured, so every arm sees the same PLEs. Filtering
  // per-arm would let the three comparisons run on three different cohorts and still print side by
  // side, which is the failure this whole harness exists to avoid.
  const scope = { manifest: MANIFEST ? { file: MANIFEST.file, sha256: MANIFEST.sha256, ids: MANIFEST.ids.length } : null,
    prompt: WANT_PROMPT ?? null,
    // A bare count is not reproducible: two runs both reading `"raters": 1` cannot be told apart,
    // and nothing in an audit_scores row distinguishes a recruited physician from a simulated
    // soak rater posting through the same API. `matched` (filled below) is the roster that actually
    // contributed rows, which is the one worth archiving.
    raters: RATERS ? { source: RATERS_RAW, ids: RATERS, n: RATERS.length, matched: [] } : null,
    dropped: {} };

  if (MANIFEST) {
    // Hard-error rather than intersect-and-continue. A manifest id that the database cannot answer
    // for is a question about the cohort -- was it never scored, is it test data, is the id wrong --
    // and quietly dropping it produces a smaller cohort reported under the manifest's name.
    // pleRows is the union of SCORED ids, so a miss here has two very different causes and they need
    // different actions: a wrong/pasted id, versus a real PLE nobody has scored yet. Ask the ples
    // table which it is rather than sending the reader off to re-score an id that is not a PLE.
    const known = new Set(pleRows.map(c => c.id));
    const missing = MANIFEST.ids.filter(id => !known.has(id));
    if (missing.length) {
      const real = new Set((await selectIn('ples', 'id', missing)).map(c => c.id));
      const notAPle = missing.filter(id => !real.has(id));
      const unscored = missing.filter(id => real.has(id));
      if (notAPle.length) console.error(`\n  FAIL: ${notAPle.length} manifest id(s) are not PLEs in this database at all: ${notAPle.slice(0, 5).join(', ')}${notAPle.length > 5 ? ' ...' : ''}`);
      if (unscored.length) console.error(`\n  FAIL: ${unscored.length} manifest id(s) are real PLEs with no AI, human or shadow score yet: ${unscored.slice(0, 5).join(', ')}${unscored.length > 5 ? ' ...' : ''}`);
      console.error(`\n  (${missing.length} of ${MANIFEST.ids.length} manifest ids unusable)`);
      console.error(`  Resolve each one deliberately. Do not run a scoped report over a cohort the manifest does not describe.\n`);
      process.exit(1);
    }
    const excludedByTest = MANIFEST.ids.filter(id => !allowed.has(id));
    if (excludedByTest.length) {
      console.error(`\n  FAIL: ${excludedByTest.length} manifest id(s) are is_test and would be dropped. Either they belong in the cohort (pass --include-test and say so in the report) or the manifest is wrong.\n`);
      process.exit(1);
    }
    const manifestSet = new Set(MANIFEST.ids);
    scope.dropped.ples_outside_manifest = [...allowed].filter(id => !manifestSet.has(id)).length;
    allowed = new Set(MANIFEST.ids);
  }

  // Prompt versions present. Reported ALWAYS, because pooling scores across evaluator prompts is a
  // silent defect: the famous 0.811 describes a prompt that no longer ships.
  const promptsPresent = [...new Set(aiRows.filter(r => allowed.has(r.ple_id)).map(r => r.prompt_version ?? 'unrecorded'))].sort();
  scope.prompt_versions_present = promptsPresent;
  if (WANT_PROMPT) {
    // 'unrecorded' is the sentinel promptsPresent renders for a null prompt_version, so it has to be
    // selectable too -- the only human-anchored cohort in production is exactly the all-null one, and
    // without this `--prompt unrecorded` denied and asserted the same fact in one line.
    const wantNull = WANT_PROMPT === 'unrecorded';
    const before = aiRows.filter(r => allowed.has(r.ple_id)).length;
    aiRows = aiRows.filter(r => wantNull ? r.prompt_version == null : r.prompt_version === WANT_PROMPT);
    scope.dropped.ai_rows_other_prompt_in_cohort = before - aiRows.filter(r => allowed.has(r.ple_id)).length;
    if (!aiRows.some(r => allowed.has(r.ple_id))) {
      console.error(`\n  FAIL: no ai_evaluations row in this cohort has prompt_version='${WANT_PROMPT}'. Present: ${promptsPresent.join(', ') || '(none)'}\n`);
      process.exit(1);
    }
  } else if (promptsPresent.length > 1) {
    console.log(`\n  !! ${promptsPresent.length} evaluator prompt versions in this cohort: ${promptsPresent.join(', ')}`);
    console.log(`     ICC is a property of (model x prompt x rubric). Pass --prompt <version> or report this mixture explicitly.`);
  }
  // Warned on regardless of how many versions are present: a cohort whose AI scores record NO prompt
  // is disqualifying on its own, and the single-version-all-null case is exactly the state production
  // is in. Silence there is the worst possible answer.
  if (promptsPresent.includes('unrecorded')) {
    console.log(`\n  !! some ai_evaluations rows in this cohort have NO prompt_version recorded.`);
    console.log(`     Those scores cannot be attributed to any prompt, so they cannot serve as a baseline for one.`);
  }

  // Human-source filter. Nothing in an audit_scores row says whether a person or a simulated
  // agent-rater wrote it -- the soak harness posts through the same authenticated API.
  if (RATERS) {
    const wanted = new Set(RATERS);
    const expOf = new Map();
    const audIds = [...new Set(auditRows.map(r => r.auditor_id).filter(Boolean))];
    const pros = audIds.length ? await selectIn('professionals', 'id, exp_code', audIds) : [];
    pros.forEach(pr => expOf.set(pr.id, pr.exp_code));
    const keep = (r) => wanted.has(r.auditor_id) || (expOf.get(r.auditor_id) && wanted.has(expOf.get(r.auditor_id)));
    const beforeInCohort = auditRows.filter(r => allowed.has(r.ple_id)).length;
    auditRows = auditRows.filter(keep);
    // Everything below is measured on the COHORT, not the database. A roster check that passes
    // because a named rater scored some unrelated sandbox PLE is not a check: it lets the one
    // recruitment fact this exists to surface through in silence, and prints a rater count the arms
    // never used. `matched` keeps the exp_code spelling, so the UUID clause below is what rescues a
    // rater named by id.
    const inCohort = auditRows.filter(r => allowed.has(r.ple_id));
    scope.dropped.audit_rows_other_raters_in_cohort = beforeInCohort - inCohort.length;
    const matched = new Set(inCohort.map(r => expOf.get(r.auditor_id) || r.auditor_id));
    const unmatched = RATERS.filter(v => !matched.has(v) && !inCohort.some(r => r.auditor_id === v));
    if (unmatched.length) {
      console.error(`\n  FAIL: ${unmatched.length} named rater(s) have no score on the PLEs in this cohort: ${unmatched.join(', ')}`);
      console.error(`  A rater who scored nothing here is a recruitment fact, not a filter argument - resolve it before reporting.\n`);
      process.exit(1);
    }
    scope.raters.matched = [...matched].sort();
    console.log(`  raters kept ${inCohort.length} of ${beforeInCohort} in-cohort audit rows across ${matched.size} rater(s)`);
  }

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

  // Local (shadow candidate). `provider` is the TRANSPORT ('local'); the candidate is the TRIPLE
  // (provider, model_version, prompt_version) -- the same identity the endpoint and the Model Lock
  // use (backend/src/services/agreement.js pairedSets). Pooling two candidates into one arm reports
  // a number describing neither, so group on the triple and measure exactly one -- the most recent,
  // as the endpoint does. prompt_version is in the key because the local prompt carries an addendum
  // (`pis7-prompt-<base>+local-<addendum>`) that has been rewritten mid-programme: two addenda are
  // two instruments. A null prompt_version is its own group, never pooled with a known one.
  // Group over the CORPUS, never the manifest cohort. WHICH candidate is measured is a property of
  // the model set, exactly like the contract rate above it -- and `--manifest` must not change it.
  // Grouping over the cohort made `g.latest` mean "most recent INSIDE the manifest", so a stale
  // candidate whose last rows happened to land on the manifest PLEs could displace the newest one
  // and carry a passing contract rate with it: measured FAIL 50% -> PASS 100% on the same database
  // with one flag added. The G0.5 manifest is the OLDEST PLEs and a backfill runs oldest-first, so
  // that collision is the expected shape, not a corner case.
  const shadowCorpus = (shadowRows || []).filter(r => corpusAllowed.has(r.ple_id));
  const shadowScoped = shadowCorpus.filter(r => allowed.has(r.ple_id));
  const groups = new Map();
  for (const r of shadowCorpus) {
    const pv = r.prompt_version ?? null;
    const key = JSON.stringify([r.provider, r.model_version, pv]);
    const g = groups.get(key) ?? { provider: r.provider, model_version: r.model_version, prompt_version: pv,
      rows: [], inCohort: 0, latest: 0, audited: 0, rubricVersions: new Set() };
    g.rows.push(r);
    g.rubricVersions.add(r.rubric_version ?? 'unrecorded');
    g.latest = Math.max(g.latest, Date.parse(r.evaluated_at ?? '') || 0);
    if (allowed.has(r.ple_id)) g.inCohort += 1;
    if (auditedSet.has(r.ple_id)) g.audited += 1;
    groups.set(key, g);
  }
  // Same order as the endpoint: most recent, then model_version, then prompt_version (descending).
  const byRecency = (x, y) => (y.latest - x.latest)
    || String(y.model_version ?? '').localeCompare(String(x.model_version ?? ''))
    || String(y.prompt_version ?? '').localeCompare(String(x.prompt_version ?? ''));
  const allGroups = [...groups.values()].sort(byRecency);
  const promptLabel = (g) => g.prompt_version ?? 'unrecorded';
  const groupLabel = (g) => `${g.provider}/${g.model_version} prompt=${promptLabel(g)}`;

  let candidate = null;
  if (WANT_PROVIDER || WANT_MODEL || PICK_SHADOW_PROMPT) {
    candidate = allGroups.find(g =>
      (!WANT_PROVIDER || g.provider === WANT_PROVIDER) && (!WANT_MODEL || g.model_version === WANT_MODEL)
      && (!PICK_SHADOW_PROMPT || g.prompt_version === WANT_SHADOW_PROMPT)) || null;
    if (!candidate) {
      console.log(`\n! no shadow rows match --provider=${WANT_PROVIDER ?? '*'} --model=${WANT_MODEL ?? '*'}`
        + ` --shadow-prompt=${PICK_SHADOW_PROMPT ? WANT_SHADOW_PROMPT_RAW : '*'} - shadow arms will be unavailable.`);
      if (allGroups.length) console.log(`  available: ${allGroups.map(g => `${groupLabel(g)} (${g.rows.length} rows)`).join(', ')}`);
    }
  } else {
    // Prefer the most recent candidate that actually overlaps the audited universe -- a newer
    // candidate seen only on unaudited PLEs cannot produce a human-anchored arm. Fall back to the
    // most recent overall so the coverage lines still name something.
    candidate = allGroups.find(g => g.audited > 0) || allGroups[0] || null;
  }
  if (allGroups.length > 1) {
    console.log(`\nShadow candidates present (${allGroups.length}) - measuring the marked one; --provider/--model/--shadow-prompt to switch:`);
    for (const g of allGroups) {
      console.log(`  ${g === candidate ? '->' : '  '} ${groupLabel(g)}  ${plural(g.rows.length, 'row')} corpus`
        + `${MANIFEST ? ` (${g.inCohort} in cohort)` : ''}, ${g.audited} on audited PLEs`);
    }
    // The case the triple exists for: one model on one transport, scored under two prompts. Say so
    // in words, because the list above only shows it as two lines that look almost alike.
    const sameModel = new Set(allGroups.map(g => JSON.stringify([g.provider, g.model_version])));
    if (sameModel.size < allGroups.length) {
      console.log(`  !! one model appears under more than one prompt_version. Each prompt is measured on its own,`
        + ` never pooled; --shadow-prompt <version> picks one.`);
    }
  }
  if (candidate) {
    console.log(`\nShadow candidate: ${candidate.provider}/${candidate.model_version}, prompt_version ${promptLabel(candidate)}`
      + `, rubric_version(s) ${[...candidate.rubricVersions].sort().join(', ')}`);
  }

  // A row with a non-null `error` carries NO scores (constraint shadow_scored_xor_failed). It is
  // EXCLUDED from every ICC and COUNTED as a contract failure -- "the candidate could not produce a
  // valid score set 8% of the time" is a first-class, potentially disqualifying result, and
  // averaging it away would hide exactly the thing a model swap turns on.
  const shadow = new Map();
  // Provenance of each scored shadow row (prompt / rubric), read by the no-Claude section below.
  const shadowVersions = new Map();
  let corpusScored = 0;
  let corpusFailed = 0;
  let auditedFailed = 0;
  // Two passes on purpose. The COHORT pass builds the score map every arm reads; the CORPUS pass
  // counts the same candidate's rows over everything --manifest excluded, so `corpusRate` keeps
  // meaning what its label says.
  // `candidate.rows` is now CORPUS-wide, so this cohort pass must narrow it. Without the filter,
  // out-of-cohort PLEs would leak into the `shadow` map and thence into ownIds / arms_own_cohort.
  for (const r of (candidate?.rows || []).filter(r => allowed.has(r.ple_id))) {
    const failed = r.error != null || !finiteDoms(r);
    if (failed) { if (auditedSet.has(r.ple_id)) auditedFailed += 1; continue; }
    shadow.set(r.ple_id, toScore(r));
    shadowVersions.set(r.ple_id, { prompt: r.prompt_version ?? 'unrecorded', rubric: r.rubric_version ?? 'unrecorded' });
  }
  // The corpus pass is now just the candidate's own rows -- they are already corpus-scoped and
  // already this provider/model. Re-filtering shadowRows here would be a second chance to get the
  // scope wrong for no gain.
  const corpusRows = candidate?.rows ?? [];
  for (const r of corpusRows) {
    if (r.error != null || !finiteDoms(r)) corpusFailed += 1; else corpusScored += 1;
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
  console.log(`COVERAGE  (audited universe = PLEs with at least one auditor score${RATERS ? ' FROM A NAMED RATER' : ''})`);
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

  // -- local vs auditor, no Claude row required (separate section, own n) --
  // Every cohort PLE with a scored shadow row from the measured candidate AND >=1 auditor score,
  // whether or not ai_evaluations has a row. `shadow` and `human` are already cohort-scoped
  // (allowed / --manifest / --raters), so this inherits the scope without re-deriving it.
  const noClaudeIds = shadowTableMissing ? [] : auditedIds.filter(id => shadow.has(id));
  const noClaudeArm = noClaudeIds.length ? armOn(noClaudeIds, NO_CLAUDE_ARM) : null;
  const noClaudeWithout = noClaudeIds.filter(id => !ai.has(id)).length;
  printArm(NO_CLAUDE_ARM, noClaudeArm, null,
    `${plural(noClaudeIds.length, 'PLE')} with a Local and an auditor score (${noClaudeWithout} of them have no Claude row) - its own n`);
  // ICC is a property of (model x prompt x rubric): report the mixture under this arm exactly as the
  // ai_evaluations prompt check above does, and warn rather than silently pool.
  const noClaudePrompts = [...new Set(noClaudeIds.map(id => shadowVersions.get(id)?.prompt ?? 'unrecorded'))].sort();
  const noClaudeRubrics = [...new Set(noClaudeIds.map(id => shadowVersions.get(id)?.rubric ?? 'unrecorded'))].sort();
  if (noClaudeIds.length) {
    console.log(`  shadow prompt version(s): ${noClaudePrompts.join(', ')}`);
    console.log(`  shadow rubric version(s): ${noClaudeRubrics.join(', ')}`);
    if (noClaudePrompts.length > 1 || noClaudeRubrics.length > 1) {
      console.log(`\n  !! this arm pools ${noClaudePrompts.length} prompt and ${noClaudeRubrics.length} rubric version(s).`);
      console.log(`     ICC is a property of (model x prompt x rubric). Narrow the cohort (--manifest) or report this mixture explicitly.`);
    }
    if (noClaudePrompts.includes('unrecorded') || noClaudeRubrics.includes('unrecorded')) {
      console.log(`\n  !! some shadow rows in this arm have NO prompt/rubric version recorded - they cannot be attributed to a prompt.`);
    }
  }

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
  // THREE_WAY_RUNS_DIR exists so the regression suite can archive into a temp dir instead of
  // polluting the committed runs/. Unset -- which is every real invocation -- is unchanged.
  const dir = process.env.THREE_WAY_RUNS_DIR || path.join(__dirname, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-three-way.json`);
  fs.writeFileSync(file, JSON.stringify({
    stamp,
    mode: 'three-way',
    db_host: host,
    include_test: INCLUDE_TEST,
    // What this run was scoped to. A number without its cohort is not reproducible.
    scope,
    gates: { icc_gate: ICC_GATE, contract_min: CONTRACT_MIN, non_inferiority_margin: MARGIN },
    shadow: {
      available: shadowAvailable,
      table_present: !shadowTableMissing,
      provider: candidate?.provider ?? null,
      model_version: candidate?.model_version ?? null,
      // The third part of the candidate's identity. null when the rows carry none, as in the DB.
      prompt_version: candidate?.prompt_version ?? null,
      rubric_versions: candidate ? [...candidate.rubricVersions].sort() : [],
      candidates: allGroups.map(g => ({ provider: g.provider, model_version: g.model_version,
        prompt_version: g.prompt_version, rubric_versions: [...g.rubricVersions].sort(),
        rows: g.rows.length, rows_in_cohort: g.inCohort, on_audited_cles: g.audited })),
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
    // Separate cohort (see header): not comparable with `arms`, not an acceptance input.
    local_vs_auditor_no_claude: { n: noClaudeIds.length, ples_without_claude: noClaudeWithout,
      prompt_versions: noClaudePrompts, rubric_versions: noClaudeRubrics, arm: noClaudeArm },
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
