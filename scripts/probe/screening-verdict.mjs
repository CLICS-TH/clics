#!/usr/bin/env node
/*
 * Turn a model-agreement run (and optionally a repeat-consistency run) into the D18 screening verdict.
 *
 * WHY THIS EXISTS. model-agreement.mjs prints an ICC and a Bland–Altman band, and a human then eyeballs
 * "is that good enough?". The roadmap says the gate is decided by the LOWER bound of the confidence
 * interval clearing the screening threshold (D18/D19), plus two instrument checks from the 2026-09-01
 * plan: repeatability (Σ|Δ| median ≤ 2 across repeats) and parseability (valid JSON ≥ 98%). This
 * script applies exactly those rules, using the SAME code production uses for its verdicts
 * (backend/src/services/icc.js iccTwoRater + verdictFor, rimpl/src/lib/pis7.js compositeOf) so it
 * cannot disagree with GET /oversight/icc or with the Model Lock gate. It also prints how many paired
 * PLEs the observed agreement would need — the row from docs/LOCAL-MODEL-CUTOVER.md — so a
 * `insufficient` reads as "n more pairs", not "try again".
 *
 * It reads ONLY score files (ids + d1..d7 + latencies). No transcript text is ever loaded or printed.
 *
 * Run from backend/ (NODE_PATH/dotenv resolve there, like scripts/local-model/status.mjs):
 *   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/probe/screening-verdict.mjs \
 *     --agreement ../scripts/probe/report/heldout-agreement.json \
 *     --repeat    ../scripts/probe/report/heldout-repeat.json
 *
 * Flags:
 *   --agreement <file>   model-agreement.mjs --out file (required)
 *   --repeat <file>      repeat-consistency.mjs --out file (optional; without it Σ|Δ| is "not measured")
 *   --threshold <0-1>    override the screening threshold (skips the app_settings read; offline use)
 *   --allow-tuning       accept a run made on the TUNING split (never a gate result — labelled as such)
 *   --json               machine-readable
 *
 * Exit codes: 0 pass · 1 fail · 3 insufficient · 2 misconfigured / unreadable input.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeParseability } from './parseability.mjs';
import { promptDrift } from './prompt-drift.mjs';

const require = createRequire(`${process.cwd()}/`);
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const argStr = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : undefined; };
const AS_JSON = has('json');
const die = (msg) => { console.error(`\n  ✘ ${msg}\n`); process.exit(2); };

if (has('help') || argv.includes('-h')) {
  console.log(`Usage (from backend/): NODE_PATH="$PWD/node_modules" node ../scripts/probe/screening-verdict.mjs --agreement <file> [--repeat <file>] [--threshold 0.75] [--allow-tuning] [--json]

Turns a model-agreement --out file (and optionally a repeat-consistency --out file) into the D18 screening
verdict — pass | fail | insufficient — using the production ICC code (backend/src/services/icc.js) and the
weighted PIS-7 composite (rimpl/src/lib/pis7.js). Adds the repeatability (Σ|Δ| median ≤ 2) and parseability
(valid JSON ≥ 98%) checks, refuses a tuning-split run without --allow-tuning (D13), and prints the
pairs-needed ladder plus a ready-to-paste prompt-versions.md row. Reads score files only; never transcript text.

  --agreement <file>   required; model-agreement.mjs --out
  --repeat <file>      optional; repeat-consistency.mjs --out (without it Σ|Δ| is "not measured")
  --threshold <0-1>    override app_settings.icc_gate_screening (offline use; otherwise read from the DB)
  --allow-tuning       show numbers for a TUNING-split file, labelled NOT A GATE RESULT
  --json               machine-readable output

Exit codes: 0 pass · 1 fail · 3 insufficient · 2 misconfigured / unreadable input.`);
  process.exit(0);
}

// ---- production code, not a re-implementation ------------------------------------------------------
let icc, pis7, versions;
try {
  icc = require('./src/services/icc.js');                 // iccTwoRater, verdictFor, pairsNeededTwoRater
  pis7 = require('../rimpl/src/lib/pis7.js');             // compositeOf (weighted, 0–100)
  versions = require('../rimpl/src/lib/versions.js');     // promptVersionFor — the exact labels reports are stamped with
} catch (e) {
  die(`run this from backend/ — could not load production modules: ${e.message}`);
}
const { iccTwoRater, verdictFor } = icc;
const { compositeOf } = pis7;
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

// ---- inputs ----------------------------------------------------------------------------------------
const agreementPath = argStr('agreement');
if (!agreementPath) die('--agreement <model-agreement --out file> is required');
const readJson = (p) => { try { return JSON.parse(readFileSync(resolve(p), 'utf8')); } catch (e) { die(`cannot read ${p}: ${e.message}`); } };
const agreement = readJson(agreementPath);
const repeat = argStr('repeat') ? readJson(argStr('repeat')) : null;
if (!Array.isArray(agreement.rows)) die('agreement file has no rows[] — is this a model-agreement --out file?');

const splitName = agreement.split?.name ?? null;
if (splitName !== 'heldout' && !has('allow-tuning')) {
  die(`this run is on split "${splitName ?? 'none'}", not the held-out split. A gate verdict is only valid on `
    + `--split heldout (D13). Pass --allow-tuning to see the numbers anyway — they will be labelled NOT A GATE RESULT.`);
}
const isGate = splitName === 'heldout';
if (repeat && repeat.split?.name && repeat.split.name !== splitName) {
  die(`split mismatch: agreement is "${splitName}" but repeat file is "${repeat.split.name}"`);
}

// ---- threshold: app_settings (production truth) unless overridden ---------------------------------
let threshold = argStr('threshold') != null ? Number(argStr('threshold')) : null;
let thresholdSource = 'flag';
if (threshold == null) {
  try {
    require('dotenv').config();
    const { iccGates } = require('./src/lib/settings.js');
    threshold = (await iccGates()).screening;
    thresholdSource = 'app_settings.icc_gate_screening';
  } catch (e) {
    die(`could not read the screening threshold from app_settings (${e.message}). Pass --threshold 0.75 to run offline.`);
  }
}
if (!(threshold > 0 && threshold < 1)) die(`threshold must be in (0,1), got ${threshold}`);

// ---- ICC on the composite both models produced for the same PLE -----------------------------------
const rows = agreement.rows;
const paired = rows.filter((r) => r.local && r.cloud && DOMAINS.every((d) => Number.isFinite(r.local[d]) && Number.isFinite(r.cloud[d])));
const comps = paired.map((r) => ({ id: r.id, a: compositeOf(r.local), b: compositeOf(r.cloud) }));
const iccResult = iccTwoRater(comps) ?? { icc: null, lower: null, upper: null, n: comps.length };
const verdict = verdictFor(iccResult, threshold);
// Per-domain, informational (production's gate is on the composite).
const perDomain = Object.fromEntries(DOMAINS.map((d) => [d, iccTwoRater(paired.map((r) => ({ a: r.local[d], b: r.cloud[d] })))?.icc ?? null]));

// ---- repeatability: Σ over domains of (max − min) across repeats, per fixture; median ≤ 2 -----------
let sigma = null;
if (repeat) {
  const local = (repeat.results ?? []).filter((r) => r.arm === 'local' && Array.isArray(r.runs) && r.runs.length >= 2);
  const per = local.map((r) => DOMAINS.reduce((a, d) => { const v = r.runs.map((s) => s[d]); return a + (Math.max(...v) - Math.min(...v)); }, 0));
  const sorted = [...per].sort((x, y) => x - y);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  sigma = { fixtures: per.length, repeats: repeat.repeats ?? null, median, max: per.length ? Math.max(...per) : null, pass: median != null ? median <= 2 : null };
}

// ---- parseability: valid PIS-7 JSON on the local arm, across every local CALL we know about ---------
// The rules and the reasons live in parseability.mjs, with a test per rule. They were inline here once;
// that is how the same accounting error reached three different wrong answers about one run in a day.
const { attempted, parsed, excluded, legacy } = computeParseability(rows, repeat);
const jsonPct = attempted ? (100 * parsed) / attempted : null;
const jsonPass = jsonPct != null ? jsonPct >= 98 : null;

// ---- pairs needed for the lower bound to clear the threshold, at a given true agreement --------------
// From icc.js itself (pairsNeededTwoRater), so the ladder is built on the same F-based interval the
// verdict uses. It is the n at which an interval CENTRED ON THE TRUTH just clears the bar — about a
// coin-flip chance of `pass`. 80% power needs far more (simulated 2026-10: 0.90 → ~36, 0.88 → ~60).
const pairsNeeded = (rho, thr) => icc.pairsNeededTwoRater(rho, thr);
const ladder = [0.95, 0.92, 0.9, 0.88, 0.85, 0.82, 0.8].map((rho) => ({ rho, pairs: pairsNeeded(rho, threshold) }));
const atObserved = iccResult.icc != null ? pairsNeeded(iccResult.icc, threshold) : null;

// ---- overall -----------------------------------------------------------------------------------------
// ICC decides pass/fail/insufficient; the two instrument checks can only pull a pass down to fail.
let state = verdict.state;
const reasons = [verdict.why];
if (state === 'pass' && sigma?.pass === false) { state = 'fail'; reasons.push(`repeatability Σ|Δ| median ${sigma.median} > 2`); }
if (state === 'pass' && jsonPass === false) { state = 'fail'; reasons.push(`valid JSON ${jsonPct.toFixed(1)}% < 98%`); }
if (!isGate) reasons.unshift('TUNING split — NOT A GATE RESULT');

// The prompt that produced THIS RUN, as the run recorded it — never the working tree's prompt today.
// (Caught 2026-09-02: a baseline run made before the local addendum existed was stamped with the
// addendum's sha, because the tool hashed prompts.js at report time. A calibration table whose rows
// are labelled with whatever is checked out when you read them is worse than no table.)
// Whether it drifted is decided in prompt-drift.mjs, with a test per failure mode. Inline here it
// hashed the ASSEMBLED prompt and hunted for that digest inside a label built from the ADDENDUM ALONE,
// so it fired on all 7 addendum-ON reports (4 stale, 3 current) and could never fire on an
// addendum-OFF one. It now compares whole labels straight from the module that stamps them.
const recordedLocalVersion = agreement.local_prompt_version ?? null;
const treeLocalVersion = versions.promptVersionFor('local');
const drift = promptDrift({
  recordedLocal: recordedLocalVersion,
  recordedBase: agreement.prompt_version ?? null,
  treeLocal: treeLocalVersion,
  treeBase: versions.promptVersionFor(),
});
// A run predating the recording (or one written by an older probe) has no version: say so, do not guess.
const promptSha = recordedLocalVersion ?? `unrecorded (tree today: ${treeLocalVersion})`;
// The F-based interval can be null while the point estimate is not (Satterthwaite v = 0), so each
// bound is formatted on its own.
const f3 = (v) => (v == null ? '—' : v.toFixed(3));
const ci = iccResult.icc == null ? '—' : `${f3(iccResult.icc)} (${f3(iccResult.lower)}–${f3(iccResult.upper)})`;
const row = `| ${agreement.models?.local ?? agreement.localModel ?? '?'} vs ${agreement.cloudModel ?? '?'} | ${promptSha} | ${splitName ?? 'none'} (n=${iccResult.n}) | ${agreement.consistency ?? 'off'} | ${ci} | ${sigma?.median ?? 'n/m'} | ${jsonPct == null ? 'n/m' : jsonPct.toFixed(1) + '%'} | ${state} |`;

const out = {
  state, reasons, gate: isGate, split: splitName, threshold, threshold_source: thresholdSource,
  icc: { ...iccResult, verdict: verdict.state }, per_domain_icc: perDomain,
  repeatability: sigma, json: { attempted, parsed, pct: jsonPct, pass: jsonPass, excluded, legacy },
  pairs_needed: { at_observed_icc: atObserved, ladder }, prompt_sha: promptSha, prompt_version: agreement.prompt_version ?? null,
  models: { local: agreement.localModel ?? null, cloud: agreement.cloudModel ?? null }, prompt_versions_row: row,
};

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
else {
  const tag = state === 'pass' ? '\x1b[32mPASS\x1b[0m' : state === 'fail' ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mINSUFFICIENT\x1b[0m';
  console.log(`\n  D18 screening verdict  ${tag}${isGate ? '' : '   \x1b[33m(tuning split — not a gate result)\x1b[0m'}`);
  for (const r of reasons) console.log(`    · ${r}`);
  console.log(`\n  ICC(A,1) composite (weighted 0–100)  ${ci}   n=${iccResult.n} pairs   threshold ${threshold} (${thresholdSource})`);
  console.log(`  per-domain ICC  ${DOMAINS.map((d) => `${d} ${perDomain[d] == null ? '—' : perDomain[d].toFixed(2)}`).join('  ')}`);
  console.log(`  repeatability   ${sigma ? `Σ|Δ| median ${sigma.median} (max ${sigma.max}) over ${sigma.fixtures} fixtures × ${sigma.repeats ?? '?'} repeats → ${sigma.pass ? 'ok' : 'over 2'}` : 'not measured (pass --repeat)'}`);
  console.log(`  parseability    ${jsonPct == null ? 'n/m' : `${parsed}/${attempted} valid JSON = ${jsonPct.toFixed(1)}% → ${jsonPass ? 'ok' : 'under 98%'}`}`
    + (excluded ? `\x1b[2m   (${excluded} call${excluded === 1 ? '' : 's'} excluded: transport only — a model that replied with unusable JSON is always counted)\x1b[0m` : '')
    + (legacy ? '\x1b[33m   [report predates per-call accounting — counted per FIXTURE, and transport is indistinguishable from bad JSON: read as a floor, not a rate]\x1b[0m' : ''));
  console.log(`\n  pairs needed for the lower bound to clear ${threshold} (≈50% chance of pass — 80% power needs roughly 2×):`);
  console.log(`    at the observed ICC ${iccResult.icc ?? '—'}: ${atObserved ?? 'never (point estimate not above threshold)'}`);
  console.log(`    ladder  ${ladder.map((l) => `${l.rho}→${l.pairs ?? '∞'}`).join('   ')}`);
  if (drift.drift) console.log(`\n  note · this run recorded prompt ${drift.recorded}\n         the working tree now builds ${drift.tree}\n         The row below reports the RUN's prompt.`);
  console.log(`\n  prompt-versions.md row (model axis):\n  ${row}\n`);
}
process.exit(state === 'pass' ? 0 : state === 'fail' ? 1 : 3);
