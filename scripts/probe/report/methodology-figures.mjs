#!/usr/bin/env node
/*
 * Every number the local-vs-Sonnet methodology report quotes, recomputed from the raw probe JSONs.
 *
 * WHY THIS EXISTS. The two PDFs already in Manuscript/ were rendered from HTML hand-authored in a
 * /private/tmp session scratchpad that no longer exists. Their figures are therefore unfalsifiable:
 * nothing on disk can be run to check them, and nothing would notice if one drifted. A Methods
 * section whose numbers cannot be regenerated is exactly the defect this file removes — so the
 * methodology report quotes NOTHING that this script does not print.
 *
 * WHAT IT IS. Read-only, offline, zero-cost. It opens scripts/probe/report/*.json and nothing else:
 * no network, no API key, no fixture read, no transcript text. Scores, ids, timings and token
 * counters only — the same discipline screening-verdict.mjs keeps.
 *
 * WHAT IT REUSES, AND WHY THAT MATTERS.
 *   backend/src/services/icc.js  iccTwoRater  — the production ICC(A,1) + Fisher-z interval, the same
 *                                              code behind GET /oversight/icc and the Model Lock gate.
 *   rimpl/src/lib/pis7.js        compositeOf  — the weighted ×20 composite (range 20–100).
 *   scripts/probe/parseability.mjs computeParseability — the valid-JSON bar, with its two hard-won
 *                                              accounting rules and its `legacy` floor flag.
 *   scripts/probe/lib.mjs        table/percentile/… — the house output helpers.
 * A second implementation of any of these could disagree with production, and a paper that quotes
 * the disagreeing one is wrong in print. The one thing NOT available from production is the variance
 * DECOMPOSITION (iccTwoRater returns the ratio, not its parts), so `varianceComponents` below
 * recomputes the mean squares — and then checks that the ICC implied by its own components matches
 * iccTwoRater to 3 dp, printing a loud FAIL if they ever drift apart.
 *
 * TWO DIFFERENT Σ|Δ|, ONE COLUMN NAME. scripts/calibration/prompt-versions.md records both of these
 * under "Σ|Δ|", which is how a repeatability floor got read as an agreement figure:
 *   sum_delta_agreement     Σ over d1..d7 of |local − cloud| on ONE fixture. Local vs Sonnet.
 *                           This is disagreement BETWEEN the two models.
 *   sum_delta_repeatability Σ over d1..d7 of (max − min) across N repeats of the LOCAL model on one
 *                           fixture. This is the local model disagreeing with ITSELF — a noise
 *                           floor. An agreement Σ|Δ| at or below it means nothing.
 * They are never printed under the same heading here, and the JSON keys are the long names above.
 *
 * HOUSE RULES OBSERVED
 *   · Every rate carries its counts: "94.4%" always appears as "17/18".
 *   · A field an older report never recorded emits null plus legacy:true — never a guessed value.
 *   · The permutation test is seeded (mulberry32, the SPLIT.json seed) so it answers the same every
 *     run, and is backed by an EXACT enumeration of all C(26,8) subsets, which needs no seed at all.
 *
 * USAGE (from the repo root — the production modules resolve from there):
 *   node scripts/probe/report/methodology-figures.mjs            # readable tables
 *   node scripts/probe/report/methodology-figures.mjs --json     # machine-readable, everything
 *   node scripts/probe/report/methodology-figures.mjs --check    # exit 1 if a self-check fails
 *
 * Flags: --json · --dir <report dir> · --seed <int> · --iters <int> · --no-exact · --check · --help
 * Exit codes: 0 ok · 1 a self-check failed (only with --check) · 2 unreadable input.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeParseability } from '../parseability.mjs';
import { table, hr, percentile, bold, dim, red, yellow, green, parseArgs, intArg } from '../lib.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(`${REPO_ROOT}/`);

let iccMod, pis7Mod;
try {
  iccMod = require('./backend/src/services/icc.js');   // iccTwoRater — production ICC(A,1) + Fisher-z CI
  pis7Mod = require('./rimpl/src/lib/pis7.js');        // compositeOf — weighted ×20, range 20–100
} catch (e) {
  console.error(`\n  ✘ could not load the production estimators: ${e.message}`);
  console.error('    Run from the repo root, and make sure rimpl/node_modules exists (npm --prefix rimpl install).\n');
  process.exit(2);
}
const { iccTwoRater } = iccMod;
const { compositeOf } = pis7Mod;

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const D18_REPEATABILITY_BAR = 2;   // Σ|Δ| repeatability median ≤ 2 (2026-09-01 plan)
const D18_PARSEABILITY_BAR = 98;   // valid PIS-7 JSON ≥ 98%

/* ══════════════════════════════════════════════════════════════════ pure helpers ══ */

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** Sample SD (n−1). Null below two values: one number has no spread, and 0 would read as "agreed". */
export const sd = (xs) => (xs.length < 2 ? null : Math.sqrt(xs.reduce((a, v) => a + (v - mean(xs)) ** 2, 0) / (xs.length - 1)));
export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Σ over d1..d7 of |local − cloud| for one fixture — disagreement BETWEEN the two models. */
export const sumDeltaAgreement = (local, cloud) =>
  DOMAINS.reduce((a, d) => a + Math.abs(local[d] - cloud[d]), 0);

/** Σ over d1..d7 of (max − min) across repeats — the LOCAL model's noise floor on one fixture.
 *  Identical to repeat-consistency.mjs:245 and screening-verdict.mjs, deliberately. */
export const sumDeltaRepeatability = (runs) =>
  DOMAINS.reduce((a, d) => { const v = runs.map((s) => s[d]); return a + (Math.max(...v) - Math.min(...v)); }, 0);

const hasAllDomains = (s) => s != null && DOMAINS.every((d) => Number.isFinite(s[d]));
/** Fixture ids are `PLE-001` in the reports and `ple-001` in SPLIT.json. One casing, everywhere. */
const key = (id) => String(id).toLowerCase();
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const fmt = (v, dp = 2) => (v == null ? '—' : v.toFixed(dp));
/** A rate is never printed without the counts it came from. */
const rate = (num, den, dp = 1) => (den ? `${((100 * num) / den).toFixed(dp)}% (${num}/${den})` : `— (0/0)`);

/** mulberry32 — the same PRNG SPLIT.json used to draw the held-out set, so one seed governs both. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ════════════════════════════════════════════════════════ variance decomposition ══ */

/**
 * Split the paired composites into the two variances an ICC is a ratio of.
 *
 * @param {{a:number,b:number}[]} pairs  a = local, b = cloud
 * @returns {{n, k, MSb, MSc, MSe, sdBetween, sdError, ratio, iccFromComponents}|null}
 *
 * sdBetween is how far the EPISODES stand apart (signal); sdError is how far the two SCORERS stand
 * apart on the same episode (noise). ICC ≈ ratio²/(ratio²+1) when there is no column bias, so a
 * ratio below 1 — episodes differing by less than the scorers do — caps the achievable ICC below
 * 0.5 no matter how good the model is. That is a property of the CORPUS, not of the model, and it
 * is why the held-out arm cannot pass a 0.75 gate however the prompt is tuned.
 *
 * The mean squares are the same ones iccTwoRater computes internally (it returns only their ratio).
 * `iccFromComponents` re-derives the ICC from them purely so the caller can assert the two agree —
 * see checkAgainstProduction(). This is a decomposition of the production estimator, not a rival one.
 */
export function varianceComponents(pairs) {
  const n = pairs.length;
  const k = 2;
  if (n < 2) return null;
  const grand = pairs.reduce((a, p) => a + p.a + p.b, 0) / (n * k);
  const rowMeans = pairs.map((p) => (p.a + p.b) / 2);
  const colMeans = [pairs.reduce((a, p) => a + p.a, 0) / n, pairs.reduce((a, p) => a + p.b, 0) / n];

  const SSr = k * rowMeans.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SSc = n * colMeans.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SStotal = pairs.reduce((a, p) => a + (p.a - grand) ** 2 + (p.b - grand) ** 2, 0);
  const SSe = SStotal - SSr - SSc;

  const MSb = SSr / (n - 1);
  const MSc = SSc / (k - 1);
  // The 0.0001 floor is icc.js's, kept here so the components cannot imply an ICC the gate would not.
  const MSe = Math.max(SSe / ((n - 1) * (k - 1)), 0.0001);

  const sdBetween = Math.sqrt(Math.max(0, (MSb - MSe) / k));
  const sdError = Math.sqrt(MSe);
  const iccFromComponents = (MSb - MSe) / (MSb + (k - 1) * MSe + (k * (MSc - MSe)) / n);
  return {
    n, k,
    // Raw marginal spreads, for scale. cloudSD is the corpus as Sonnet sees it — the widest the
    // signal ever gets — so sdBetween can be read against it rather than in the abstract.
    cloudSd: r2(sd(pairs.map((p) => p.b))),
    localSd: r2(sd(pairs.map((p) => p.a))),
    MSb: r3(MSb), MSc: r3(MSc), MSe: r3(MSe),
    sdBetween: r2(sdBetween), sdError: r2(sdError),
    ratio: sdError > 0 ? r2(sdBetween / sdError) : null,
    iccFromComponents: r3(iccFromComponents),
  };
}

/** True when the decomposition's own ICC matches the production estimator to 3 dp. */
const checkAgainstProduction = (components, iccResult) =>
  components == null || iccResult?.icc == null
    ? null
    : Math.abs(components.iccFromComponents - iccResult.icc) <= 0.0015;

/* ═══════════════════════════════════════════════════════════════ report loading ══ */

const isAgreement = (name) => /agreement.*\.json$/.test(name) || /^heldout.*\.json$/.test(name);
const isRepeat = (name) => /repeat.*\.json$/.test(name) || /^noise-.*\.json$/.test(name);

function loadReports(dir) {
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch (e) { console.error(`\n  ✘ cannot read ${dir}: ${e.message}\n`); process.exit(2); }
  return names.map((name) => {
    const path = join(dir, name);
    const raw = readFileSync(path, 'utf8');
    return {
      name,
      path,
      mtime: statSync(path).mtime.toISOString(),
      // Provenance that survives a re-checkout, which mtime does not.
      sha256: createHash('sha256').update(raw).digest('hex').slice(0, 12),
      json: JSON.parse(raw),
    };
  });
}

/* ═══════════════════════════════════════════════════ (a) per agreement run ══ */

/**
 * One agreement run: what it was configured as, what it actually did, and how well the two models
 * agreed. Anything the report never recorded comes back null with `legacy` naming the missing field.
 */
export function agreementRow(file) {
  const j = file.json;
  const rows = j.rows ?? [];
  const paired = rows.filter((r) => hasAllDomains(r.local) && hasAllDomains(r.cloud));
  const comps = paired.map((r) => ({ id: key(r.id), a: compositeOf(r.local), b: compositeOf(r.cloud) }));

  const iccResult = comps.length >= 2 ? iccTwoRater(comps) : null;
  const components = varianceComponents(comps);
  const diffs = comps.map((c) => c.a - c.b);
  const biasMean = mean(diffs);
  const biasSd = sd(diffs);

  // Unweighted sum-of-domains too: model-agreement.mjs prints its Bland–Altman band on THAT scale,
  // and a reader holding both documents must be able to see why the two numbers differ.
  const unweighted = paired.map((r) => DOMAINS.reduce((a, d) => a + r.local[d] - r.cloud[d], 0));

  const deltas = paired.map((r) => sumDeltaAgreement(r.local, r.cloud));
  const parse = computeParseability(rows, null);

  // Stamped vs observed consistency. The run labelled `median3` has `mode:"adaptive"` and 2 calls on
  // every single row — the rule was hardcoded and never ran. A table that reprints the stamp alone
  // would attribute a re-run's variance to a rule change that did not happen.
  const observedModes = [...new Set(rows.map((r) => r.consistency?.mode).filter(Boolean))];
  const observedCalls = [...new Set(rows.map((r) => r.consistency?.calls).filter((v) => v != null))].sort((a, b) => a - b);

  const legacy = [];
  if (j.arm_attempts == null) legacy.push('arm_attempts');
  if (parse.legacy) legacy.push('per-call parseability');
  if (rows.some((r) => r.localError === undefined)) legacy.push('localError stamp');

  const failures = rows.filter((r) => !hasAllDomains(r.local) || !hasAllDomains(r.cloud)).map((r) => ({
    id: key(r.id),
    local_error: r.local ? null : (r.localError ?? 'unrecorded (local scores absent)'),
    cloud_error: r.cloud ? null : (r.cloudError ?? 'unrecorded (cloud scores absent)'),
    local_ms: r.localMs ?? null,
    cloud_ms: r.cloudMs ?? null,
  }));

  return {
    file: file.name,
    mtime: file.mtime,
    sha256: file.sha256,
    split: j.split?.name ?? null,
    consistency_stamped: j.consistency ?? null,
    consistency_observed: observedModes.length ? observedModes.join('/') : null,
    consistency_observed_calls: observedCalls,
    // The one boolean a reader needs before quoting the stamp as a condition of the experiment.
    stamp_matches_rows: j.consistency == null || observedModes.length === 0
      ? null
      : observedModes.length === 1 && observedModes[0] === j.consistency,
    local_prompt_version: j.local_prompt_version ?? null,
    cloud_prompt_version: j.prompt_version ?? null,
    local_model: j.localModel ?? null,
    cloud_model: j.cloudModel ?? null,
    arm_attempts: j.arm_attempts ?? null,
    n_rows: rows.length,
    n_paired: comps.length,
    n_lost: rows.length - comps.length,
    icc: iccResult ? { value: iccResult.icc, lower: iccResult.lower, upper: iccResult.upper, n: iccResult.n, interpretation: iccResult.interpretation } : null,
    composite_scale: 'weighted ×20 (rimpl compositeOf), range 20–100',
    bias_weighted: r2(biasMean),
    bias_weighted_sd: r2(biasSd),
    bland_altman_weighted: biasMean == null || biasSd == null ? null
      : { lower: r2(biasMean - 1.96 * biasSd), upper: r2(biasMean + 1.96 * biasSd) },
    bias_unweighted_sum: r2(mean(unweighted)),
    bland_altman_unweighted_sum: unweighted.length < 2 ? null : {
      lower: r2(mean(unweighted) - 1.96 * sd(unweighted)),
      upper: r2(mean(unweighted) + 1.96 * sd(unweighted)),
    },
    sum_delta_agreement: {
      median: median(deltas),
      mean: r2(mean(deltas)),
      max: deltas.length ? Math.max(...deltas) : null,
      n: deltas.length,
    },
    parseability: {
      parsed: parse.parsed, attempted: parse.attempted, excluded: parse.excluded,
      pct: r2(parse.pct), pass: parse.pass, legacy: parse.legacy,
      bar: D18_PARSEABILITY_BAR,
      // A legacy report counts one FIXTURE as one attempt and cannot tell a timeout from bad JSON,
      // so its percentage is a floor. Saying so is the difference between a caveat and a false claim.
      basis: parse.legacy ? 'per fixture (floor, not a rate)' : 'per model call',
    },
    latency_ms: {
      local_p50: percentile(rows.map((r) => r.localMs).filter(Number.isFinite), 50),
      cloud_p50: percentile(rows.map((r) => r.cloudMs).filter(Number.isFinite), 50),
    },
    variance: components,
    variance_matches_production_icc: checkAgainstProduction(components, iccResult),
    failures,
    legacy: legacy.length > 0,
    legacy_fields: legacy,
  };
}

/* ══════════════════════════════════════════════════════ (b) per repeat run ══ */

/**
 * One repeat-consistency run: the LOCAL model against itself. `repeats` is what was requested;
 * `fixtures_measurable` is how many actually returned ≥2 usable scores — the two differ whenever the
 * box dropped calls, and reporting the requested count as if it were the achieved one is how a
 * noise floor measured on 10 of 18 fixtures gets quoted as if it covered all 18.
 */
export function repeatRow(file) {
  const j = file.json;
  const local = (j.results ?? []).filter((r) => r.arm === 'local');
  const measurable = local.filter((r) => Array.isArray(r.runs) && r.runs.length >= 2 && r.runs.every(hasAllDomains));
  const per = measurable.map((r) => ({
    id: key(r.fixture ?? r.id),
    runs: r.runs.length,
    sum_delta_repeatability: sumDeltaRepeatability(r.runs),
  }));
  const sigmas = per.map((p) => p.sum_delta_repeatability);
  const med = median(sigmas);
  const parse = computeParseability([], j);

  const legacy = [];
  if (j.addendum == null) legacy.push('addendum');
  if (j.consistency == null) legacy.push('consistency');
  if (local.some((r) => !Array.isArray(r.errors))) legacy.push('per-repeat errors[]');

  return {
    file: file.name,
    mtime: file.mtime,
    sha256: file.sha256,
    split: j.split?.name ?? null,
    addendum: j.addendum ?? null,
    consistency: j.consistency ?? null,
    local_prompt_version: j.local_prompt_version ?? null,
    local_model: j.localModel ?? null,
    repeats_requested: j.repeats ?? null,
    fixtures_total: local.length,
    fixtures_measurable: measurable.length,
    repeat_counts: [...new Set(measurable.map((r) => r.runs.length))].sort((a, b) => a - b),
    sum_delta_repeatability: {
      median: med,
      max: sigmas.length ? Math.max(...sigmas) : null,
      mean: r2(mean(sigmas)),
      at_or_below_bar: sigmas.filter((s) => s <= D18_REPEATABILITY_BAR).length,
      n: sigmas.length,
      bar: D18_REPEATABILITY_BAR,
      pass: med == null ? null : med <= D18_REPEATABILITY_BAR,
    },
    per_fixture: per,
    parseability: {
      parsed: parse.parsed, attempted: parse.attempted, excluded: parse.excluded,
      pct: r2(parse.pct), legacy: parse.legacy,
    },
    legacy: legacy.length > 0,
    legacy_fields: legacy,
  };
}

/* ═════════════════════════════════════════ (d) corpus spread + permutation ══ */

/**
 * Pool the CLOUD composite for every fixture across every agreement run.
 *
 * Legitimate only because the cloud prompt was byte-identical in all of them (`prompt_version` is
 * pis7-prompt-59561c29 in every file — asserted below, not assumed): the same instrument scoring
 * the same transcript, so repeats are re-measurements of one quantity and averaging them is the
 * right summary. It would NOT be legitimate for the local composite, whose prompt changed between
 * runs, which is why only the cloud arm is pooled here.
 */
export function poolCloudComposites(agreementFiles) {
  const byFixture = new Map();
  const promptVersions = new Set();
  for (const f of agreementFiles) {
    promptVersions.add(f.json.prompt_version ?? '(unrecorded)');
    for (const r of f.json.rows ?? []) {
      if (!hasAllDomains(r.cloud)) continue;
      const id = key(r.id);
      if (!byFixture.has(id)) byFixture.set(id, []);
      byFixture.get(id).push({ run: f.name, composite: compositeOf(r.cloud) });
    }
  }
  const pooled = new Map(
    [...byFixture].map(([id, obs]) => [id, { id, composite: r2(mean(obs.map((o) => o.composite))), observations: obs.length }]),
  );
  return { pooled, promptVersions: [...promptVersions] };
}

/** n / mean / SD / min / max for one named arm of SPLIT.json. Missing ids are named, never dropped silently. */
export function armSpread(ids, pooled) {
  const present = ids.filter((id) => pooled.has(id));
  const vals = present.map((id) => pooled.get(id).composite);
  return {
    n: vals.length,
    n_requested: ids.length,
    missing: ids.filter((id) => !pooled.has(id)),
    mean: r2(mean(vals)),
    sd: r2(sd(vals)),
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
    values: vals,
  };
}

/**
 * Is the held-out arm unusually narrow, or is 8-of-26 just a small draw?
 *
 * H0: the held-out set is an ordinary random 8-subset of the 26 pooled fixtures. The statistic is the
 * subset's SD; p is the share of subsets at or below the observed one. Small p ⇒ the reserved arm
 * really is compressed, and its low ICC is partly the split's doing rather than the model's.
 *
 * Two answers, deliberately:
 *   `exact` enumerates all C(26,8) = 1,562,275 subsets in ~15 ms. No seed, no sampling error, and it
 *          is the number the report should quote.
 *   `monte_carlo` draws `iters` subsets with a seeded mulberry32 (the SPLIT.json seed by default),
 *          so the sampled figure is reproducible too, and reports its own standard error. It exists
 *          to show the two methods agree; if the corpus ever grows past exact enumeration it becomes
 *          the primary.
 */
export function permutationTest(all, observedValues, { seed, iters, exact = true }) {
  const N = all.length;
  const k = observedValues.length;
  const sdOf = (xs) => {
    let s = 0, ss = 0;
    for (const x of xs) { s += x; ss += x * x; }
    return Math.sqrt(Math.max(0, (ss - (s * s) / xs.length) / (xs.length - 1)));
  };
  // The observed SD is measured with the SAME estimator the subsets are, so the observed set is
  // guaranteed to count as a hit. (A 2-dp display value used as the threshold admitted four extra
  // subsets and moved p by 0.09 points — the kind of drift a paper cannot see.)
  const observedSd = sdOf(observedValues);
  const EPS = 1e-9;

  const rnd = mulberry32(seed);
  const idx = [...Array(N).keys()];
  let hits = 0;
  for (let i = 0; i < iters; i++) {
    for (let j = N - 1; j > 0; j--) { const t = Math.floor(rnd() * (j + 1)); [idx[j], idx[t]] = [idx[t], idx[j]]; }
    if (sdOf(idx.slice(0, k).map((x) => all[x])) <= observedSd + EPS) hits++;
  }
  const p = hits / iters;

  let exactResult = null;
  if (exact && N <= 40 && k <= N) {
    let total = 0, eHits = 0;
    (function rec(start, depth, sum, sumsq) {
      if (depth === k) {
        total++;
        if (Math.sqrt(Math.max(0, (sumsq - (sum * sum) / k) / (k - 1))) <= observedSd + EPS) eHits++;
        return;
      }
      for (let i = start; i <= N - (k - depth); i++) rec(i + 1, depth + 1, sum + all[i], sumsq + all[i] * all[i]);
    })(0, 0, 0, 0);
    exactResult = { subsets: total, at_or_below: eHits, p: r3(eHits / total), pct: r2((100 * eHits) / total) };
  }

  return {
    statistic: 'SD of a random k-subset of the pooled cloud composites',
    k, pool_n: N, observed_sd: r2(observedSd),
    exact: exactResult,
    monte_carlo: {
      seed, iters, at_or_below: hits, p: r3(p), pct: r2(100 * p),
      // Monte-Carlo SE — the reason `exact` is the one to quote.
      se_pct: r2(100 * Math.sqrt((p * (1 - p)) / iters)),
    },
  };
}

/* ══════════════════════════════════════════════════════ (e) survivorship ══ */

/**
 * Were the fixtures a run LOST harder than the ones it kept?
 *
 * Dropping failures is not random: a harder transcript is a longer one, so it spends longer exposed
 * to a flaky box AND is the transcript the two models most disagree about. Losing it therefore
 * raises the ICC — the metric improves as the hardware gets worse. This measures the effect directly
 * by looking up each lost fixture's sum_delta_agreement in the OTHER runs where it did complete.
 *
 * The donor runs used different local prompts, so a lost fixture's borrowed Σ|Δ| is an estimate of
 * its difficulty, not of what this run would have scored. `donor_runs` is reported per fixture so a
 * reader can see how thin each estimate is.
 *
 * @param {object[]} agreementRows       rows from agreementRow()
 * @param {Map<string,{run,delta}[]>} deltaByFixture   every run's Σ|Δ|agr for every fixture it kept
 * @param {Map<string,number[]>} survivorDeltasByRun   one run's Σ|Δ|agr over the fixtures it kept
 */
export function survivorship(agreementRows, deltaByFixture, survivorDeltasByRun) {
  return agreementRows.filter((r) => r.n_lost > 0).map((run) => {
    const lost = run.failures.map(({ id }) => {
      const donors = (deltaByFixture.get(id) ?? []).filter((d) => d.run !== run.file);
      return { id, donor_runs: donors.length, mean_sum_delta_agreement: donors.length ? r2(mean(donors.map((d) => d.delta))) : null };
    });
    const estimable = lost.filter((l) => l.mean_sum_delta_agreement != null);
    const survivorDeltas = survivorDeltasByRun.get(run.file) ?? [];
    return {
      file: run.file,
      n_lost: run.n_lost,
      n_lost_estimable: estimable.length,
      lost_mean_sum_delta_agreement: estimable.length ? r2(mean(estimable.map((l) => l.mean_sum_delta_agreement))) : null,
      survivor_mean_sum_delta_agreement: survivorDeltas.length ? r2(mean(survivorDeltas)) : null,
      n_survivors: survivorDeltas.length,
      // Positive ⇒ the lost fixtures were the harder ones ⇒ this run's ICC is optimistic.
      difference: estimable.length && survivorDeltas.length
        ? r2(mean(estimable.map((l) => l.mean_sum_delta_agreement)) - mean(survivorDeltas)) : null,
      lost,
    };
  });
}

/* ══════════════════════════════════════════════════════ (f) cost + latency ══ */

/** Extra tokens the self-consistency rule spent, and wall-clock, summed over a run's rows. */
export function costRow(run) {
  const rows = run.json.rows ?? [];
  const withTokens = rows.filter((r) => r.consistency && typeof r.consistency.extra_input_tokens === 'number');
  const sum = (f) => withTokens.reduce((a, r) => a + f(r.consistency), 0);
  const localMs = rows.map((r) => r.localMs).filter(Number.isFinite);
  const cloudMs = rows.map((r) => r.cloudMs).filter(Number.isFinite);
  return {
    file: run.name,
    rows_with_token_counters: withTokens.length,
    rows_total: rows.length,
    extra_input_tokens: withTokens.length ? sum((c) => c.extra_input_tokens) : null,
    extra_output_tokens: withTokens.length ? sum((c) => c.extra_output_tokens) : null,
    json_retries: withTokens.length ? sum((c) => c.json_retries ?? 0) : null,
    local_calls: rows.reduce((a, r) => a + (r.consistency?.calls ?? 0), 0),
    local_ms_total: localMs.reduce((a, b) => a + b, 0),
    cloud_ms_total: cloudMs.reduce((a, b) => a + b, 0),
    local_ms_p50: percentile(localMs, 50),
    cloud_ms_p50: percentile(cloudMs, 50),
    legacy: withTokens.length < rows.length,
  };
}

/* ═══════════════════════════════════════════════════════════════════ assemble ══ */

function build({ dir, seed, iters, exact }) {
  const files = loadReports(dir);
  const agreementFiles = files.filter((f) => isAgreement(f.name) && Array.isArray(f.json.rows));
  const repeatFiles = files.filter((f) => isRepeat(f.name) && Array.isArray(f.json.results));
  const skipped = files.filter((f) => !agreementFiles.includes(f) && !repeatFiles.includes(f)).map((f) => f.name);

  const agreement = agreementFiles.map(agreementRow);

  // Σ|Δ| agreement per fixture per run — the donor table survivorship() borrows from, and the
  // per-run survivor list it compares against.
  const deltaByFixture = new Map();
  const survivorDeltasByRun = new Map();
  for (const f of agreementFiles) {
    const survivors = [];
    for (const r of f.json.rows ?? []) {
      if (!hasAllDomains(r.local) || !hasAllDomains(r.cloud)) continue;
      const id = key(r.id);
      const delta = sumDeltaAgreement(r.local, r.cloud);
      if (!deltaByFixture.has(id)) deltaByFixture.set(id, []);
      deltaByFixture.get(id).push({ run: f.name, delta });
      survivors.push(delta);
    }
    survivorDeltasByRun.set(f.name, survivors);
  }

  const SPLIT = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/probe/SPLIT.json'), 'utf8'));
  const { pooled, promptVersions } = poolCloudComposites(agreementFiles);
  const heldOut = armSpread(SPLIT.held_out, pooled);   // NOTE: SPLIT.json spells it held_out
  const tuning = armSpread(SPLIT.tuning, pooled);
  const allComposites = [...pooled.values()].map((p) => p.composite);
  const perm = heldOut.n < 2 ? null
    : permutationTest(allComposites, heldOut.values, { seed: seed ?? SPLIT.seed, iters, exact });

  const checks = [];
  for (const a of agreement) {
    if (a.variance_matches_production_icc === false) {
      checks.push({ ok: false, what: `${a.file}: variance components imply ICC ${a.variance.iccFromComponents}, iccTwoRater says ${a.icc?.value}` });
    }
  }
  if (promptVersions.length > 1) {
    checks.push({ ok: false, what: `cloud prompt was NOT identical across agreement runs (${promptVersions.join(', ')}) — pooling cloud composites is invalid` });
  }
  const unpooled = [...SPLIT.held_out, ...SPLIT.tuning].filter((id) => !pooled.has(id));
  if (unpooled.length) checks.push({ ok: false, what: `${unpooled.length} split fixture(s) never scored by the cloud arm: ${unpooled.join(', ')}` });
  const extra = [...pooled.keys()].filter((id) => ![...SPLIT.held_out, ...SPLIT.tuning].includes(id));
  if (extra.length) checks.push({ ok: false, what: `${extra.length} scored fixture(s) are in no SPLIT arm: ${extra.join(', ')}` });

  return {
    generated_by: 'scripts/probe/report/methodology-figures.mjs',
    generated_at: new Date().toISOString(),
    source_dir: dir.replace(`${REPO_ROOT}/`, ''),
    composite: 'PIS-7 weighted composite, rimpl/src/lib/pis7.js compositeOf (×20, range 20–100)',
    icc_model: 'ICC(A,1) = ICC(2,1), two-way random, absolute agreement, single measure — backend/src/services/icc.js iccTwoRater; 95% CI by Fisher-z with se = 1/sqrt(n-3)',
    sum_delta_definitions: {
      sum_delta_agreement: 'Σ over d1..d7 of |local − cloud| for one fixture — LOCAL vs SONNET disagreement',
      sum_delta_repeatability: 'Σ over d1..d7 of (max − min) across repeats of the LOCAL model on one fixture — the local noise floor',
    },
    split: { seed: SPLIT.seed, method: SPLIT.method, git_head: SPLIT.git_head, held_out: SPLIT.held_out.length, tuning: SPLIT.tuning.length },
    files_skipped: skipped,
    agreement_runs: agreement,
    repeat_runs: repeatFiles.map(repeatRow),
    corpus: {
      pooling_rule: 'cloud composite only, averaged when a fixture was scored in more than one run; the cloud prompt was byte-identical across runs',
      cloud_prompt_versions: promptVersions,
      fixtures_pooled: pooled.size,
      per_fixture: [...pooled.values()].sort((a, b) => a.id.localeCompare(b.id)),
      arms: { held_out: heldOut, tuning },
      permutation: perm,
    },
    survivorship: survivorship(agreement, deltaByFixture, survivorDeltasByRun),
    cost: agreementFiles.map(costRow),
    self_checks: checks.length ? checks : [{ ok: true, what: 'all self-checks passed' }],
  };
}

/* ══════════════════════════════════════════════════════════════════════ print ══ */

function print(R) {
  const cell = (v, dp = 2) => (v == null ? dim('—') : v.toFixed(dp));

  console.log(`\n${bold('  Methodology figures — local model vs Claude Sonnet')}`);
  console.log(dim(`  source ${R.source_dir}   generated ${R.generated_at}`));
  console.log(dim(`  composite: ${R.composite}`));
  console.log(dim(`  ICC: ${R.icc_model}`));
  if (R.files_skipped.length) console.log(dim(`  skipped (not an agreement or repeat report): ${R.files_skipped.join(', ')}`));

  hr('(a) agreement runs — configuration as stamped, and as the rows actually ran');
  table(
    ['file', 'mtime (UTC)', 'sha', 'split', 'stamped', 'observed', 'arm_att', 'local prompt version'],
    R.agreement_runs.map((a) => [
      a.file.replace(/\.json$/, ''),
      a.mtime.replace('T', ' ').slice(0, 16),
      a.sha256.slice(0, 8),
      a.split ?? dim('—'),
      a.consistency_stamped ?? dim('—'),
      a.stamp_matches_rows === false
        ? red(`${a.consistency_observed} ✘`)
        : `${a.consistency_observed ?? '—'}${a.consistency_observed_calls.length ? dim(` (${a.consistency_observed_calls.join('/')} calls)`) : ''}`,
      a.arm_attempts == null ? yellow('null') : String(a.arm_attempts),
      a.local_prompt_version ?? dim('—'),
    ]),
    ['l', 'l', 'l', 'l', 'l', 'l', 'r', 'l'],
  );
  for (const a of R.agreement_runs.filter((x) => x.stamp_matches_rows === false)) {
    console.log(`  ${red('✘')} ${a.file}: stamped "${a.consistency_stamped}" but every row ran "${a.consistency_observed}"`
      + ` with ${a.consistency_observed_calls.join('/')} call(s) — the stamped rule NEVER RAN.`);
  }

  hr('(a) agreement runs — agreement between the two models');
  table(
    ['file', 'rows', 'paired', 'lost', 'ICC(A,1)', '95% CI', 'bias L−C', 'B–A limits', 'Σ|Δ|agr med', 'valid JSON', 'local p50', 'cloud p50'],
    R.agreement_runs.map((a) => [
      a.file.replace(/\.json$/, '').replace(/^tuning-agreement-/, 't-').replace(/^heldout-/, 'h-'),
      String(a.n_rows), String(a.n_paired), a.n_lost ? red(String(a.n_lost)) : '0',
      a.icc ? cell(a.icc.value, 3) : dim('—'),
      a.icc ? `${cell(a.icc.lower, 3)}–${cell(a.icc.upper, 3)}` : dim('—'),
      cell(a.bias_weighted),
      a.bland_altman_weighted ? `${cell(a.bland_altman_weighted.lower)} … ${cell(a.bland_altman_weighted.upper)}` : dim('—'),
      a.sum_delta_agreement.median == null ? dim('—') : String(a.sum_delta_agreement.median),
      `${rate(a.parseability.parsed, a.parseability.attempted)}${a.parseability.legacy ? yellow('*') : ''}`,
      `${(a.latency_ms.local_p50 / 1000).toFixed(0)}s`,
      `${(a.latency_ms.cloud_p50 / 1000).toFixed(0)}s`,
    ]),
    ['l', 'r', 'r', 'r', 'r', 'l', 'r', 'l', 'r', 'l', 'r', 'r'],
  );
  console.log(dim('\n  Σ|Δ|agr = Σ|local − cloud| over d1..d7 (BETWEEN models). Bias and B–A are on the WEIGHTED'));
  console.log(dim('  composite (20–100); model-agreement.mjs prints its band on the unweighted 0–35 sum — both are'));
  console.log(dim(`  in --json. ${yellow('*')} = counted per fixture, not per call: a floor, not a rate.`));

  const withFailures = R.agreement_runs.filter((a) => a.failures.length);
  if (withFailures.length) {
    hr('(a) lost rows');
    table(
      ['file', 'fixture', 'local error', 'cloud error'],
      withFailures.flatMap((a) => a.failures.map((f) => [
        a.file.replace(/\.json$/, ''), f.id,
        f.local_error ? red(f.local_error) : dim('ok'),
        f.cloud_error ? red(f.cloud_error) : dim('ok'),
      ])),
    );
  }

  hr('(b) repeat runs — the LOCAL model against itself (noise floor)');
  table(
    ['file', 'mtime (UTC)', 'addendum', 'consistency', 'repeats', 'measurable', 'Σ|Δ|rep med', 'max', `≤ ${D18_REPEATABILITY_BAR}`, 'bar'],
    R.repeat_runs.map((r) => [
      r.file.replace(/\.json$/, ''),
      r.mtime.replace('T', ' ').slice(0, 16),
      r.addendum == null ? yellow('unrecorded') : r.addendum,
      r.consistency == null ? yellow('unrecorded') : r.consistency,
      r.repeats_requested == null ? dim('—') : String(r.repeats_requested),
      `${r.fixtures_measurable}/${r.fixtures_total}`,
      r.sum_delta_repeatability.median == null ? dim('—') : String(r.sum_delta_repeatability.median),
      r.sum_delta_repeatability.max == null ? dim('—') : String(r.sum_delta_repeatability.max),
      rate(r.sum_delta_repeatability.at_or_below_bar, r.sum_delta_repeatability.n),
      r.sum_delta_repeatability.pass == null ? dim('—') : (r.sum_delta_repeatability.pass ? green('pass') : red('over')),
    ]),
    ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'l', 'l'],
  );
  console.log(dim('\n  Σ|Δ|rep = Σ(max − min) over d1..d7 across repeats of the LOCAL model on ONE fixture (the model'));
  console.log(dim('  disagreeing with ITSELF). This is NOT the Σ|Δ| in table (a). "measurable" is fixtures that'));
  console.log(dim('  returned ≥2 usable scores — a median taken over 10 of 18 does not describe all 18.'));

  hr('(c) variance decomposition — why the ICC is capped by the corpus, not the model');
  table(
    ['file', 'n', 'cloudSD', 'localSD', 'sdBetween', 'sdError', 'ratio', 'ICC', 'check'],
    R.agreement_runs.filter((a) => a.variance).map((a) => [
      a.file.replace(/\.json$/, ''),
      String(a.variance.n),
      cell(a.variance.cloudSd), cell(a.variance.localSd),
      cell(a.variance.sdBetween), cell(a.variance.sdError),
      a.variance.ratio == null ? dim('—') : (a.variance.ratio < 1 ? red(a.variance.ratio.toFixed(2)) : a.variance.ratio.toFixed(2)),
      a.icc ? cell(a.icc.value, 3) : dim('—'),
      a.variance_matches_production_icc === false ? red('DRIFT') : green('ok'),
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  );
  console.log(dim('\n  sdBetween = sqrt(max(0,(MSb − MSe)/k)) — how far the EPISODES stand apart.'));
  console.log(dim('  sdError   = sqrt(MSe)                   — how far the two SCORERS stand apart on one episode.'));
  console.log(dim('  ratio < 1 means the episodes differ from each other by LESS than the scorers differ on the same'));
  console.log(dim('  episode, which caps any achievable ICC below 0.5 however good the model is. "check" verifies the'));
  console.log(dim('  components re-derive the production ICC to 3 dp; DRIFT means this decomposition is wrong.'));

  hr('(d) corpus spread — the cloud composite for each fixture, pooled across runs');
  const C = R.corpus;
  table(
    ['arm', 'n', 'mean', 'SD', 'min', 'max'],
    ['held_out', 'tuning'].map((k) => {
      const a = C.arms[k];
      return [k, `${a.n}/${a.n_requested}`, cell(a.mean), cell(a.sd), cell(a.min, 1), cell(a.max, 1)];
    }),
    ['l', 'r', 'r', 'r', 'r', 'r'],
  );
  console.log(dim(`\n  Pooled over ${C.fixtures_pooled} fixtures from ${R.agreement_runs.length} agreement runs; ${C.pooling_rule}.`));
  console.log(dim(`  Cloud prompt version(s) seen: ${C.cloud_prompt_versions.join(', ')}.`));
  if (C.permutation) {
    const p = C.permutation;
    console.log(`\n  ${bold('permutation test')} — is the held-out arm unusually narrow, or just a small draw?`);
    console.log(`    H0: held_out is an ordinary random ${p.k}-subset of the ${p.pool_n} pooled fixtures.`);
    console.log(`    observed held-out SD ${p.observed_sd}`);
    if (p.exact) {
      console.log(`    exact       ${bold(`${p.exact.pct.toFixed(2)}%`)} of all C(${p.pool_n},${p.k}) = ${p.exact.subsets.toLocaleString('en-US')} subsets have SD ≤ observed`
        + `  (${p.exact.at_or_below.toLocaleString('en-US')}/${p.exact.subsets.toLocaleString('en-US')})`);
    }
    console.log(`    monte carlo ${p.monte_carlo.pct.toFixed(2)}% ± ${p.monte_carlo.se_pct.toFixed(2)} (SE)`
      + `  (${p.monte_carlo.at_or_below}/${p.monte_carlo.iters}, seed ${p.monte_carlo.seed}, mulberry32)`);
    console.log(dim('    Quote the exact figure: it has no sampling error and needs no seed. The seeded draw is'));
    console.log(dim('    shown only to demonstrate the two methods agree.'));
  }

  if (R.survivorship.length) {
    hr('(e) survivorship — were the LOST fixtures the harder ones?');
    table(
      ['file', 'lost', 'estimable', 'lost mean Σ|Δ|agr', 'survivor mean', 'difference', 'n survivors'],
      R.survivorship.map((s) => [
        s.file.replace(/\.json$/, ''),
        String(s.n_lost), String(s.n_lost_estimable),
        cell(s.lost_mean_sum_delta_agreement), cell(s.survivor_mean_sum_delta_agreement),
        s.difference == null ? dim('—') : (s.difference > 0 ? red(`+${s.difference.toFixed(2)}`) : s.difference.toFixed(2)),
        String(s.n_survivors),
      ]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    );
    console.log(dim('\n  A lost fixture\'s Σ|Δ|agr is borrowed from the OTHER runs where it did complete (donor count is'));
    console.log(dim('  per fixture in --json). A positive difference means the run dropped its hardest fixtures, so its'));
    console.log(dim('  ICC is optimistic — the metric improved because the hardware got worse.'));
  }

  hr('(f) cost and wall-clock per run');
  table(
    ['file', 'counted rows', 'local calls', 'extra in tok', 'extra out tok', 're-asks', 'local total', 'cloud total', 'local p50', 'cloud p50'],
    R.cost.map((c) => [
      c.file.replace(/\.json$/, ''),
      // A failed row has no consistency object, so its tokens are simply not in the sum. Printing
      // the coverage is what stops a partial total being read as the run's whole spend.
      c.legacy ? yellow(`${c.rows_with_token_counters}/${c.rows_total}`) : `${c.rows_with_token_counters}/${c.rows_total}`,
      String(c.local_calls),
      c.extra_input_tokens == null ? yellow('unrecorded') : c.extra_input_tokens.toLocaleString('en-US'),
      c.extra_output_tokens == null ? yellow('unrecorded') : c.extra_output_tokens.toLocaleString('en-US'),
      c.json_retries == null ? dim('—') : String(c.json_retries),
      `${(c.local_ms_total / 60000).toFixed(1)}m`,
      `${(c.cloud_ms_total / 60000).toFixed(1)}m`,
      `${(c.local_ms_p50 / 1000).toFixed(0)}s`,
      `${(c.cloud_ms_p50 / 1000).toFixed(0)}s`,
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
  );
  console.log(dim('\n  "extra" tokens are what the self-consistency rule spent ON TOP of a single call, from the'));
  console.log(dim('  per-row consistency counters. "counted rows" is how many rows carried those counters —'));
  console.log(dim('  a lost row carries none, so a total below 18/18 is a partial spend, not the run\'s whole cost.'));
  console.log(dim('  Wall-clock totals cover every row, lost ones included; they are elapsed time, not billed time.'));

  hr('self-checks');
  for (const c of R.self_checks) console.log(`  ${c.ok ? green('✔') : red('✘')} ${c.what}`);
  console.log();
}

/* ═══════════════════════════════════════════════════════════════════════ main ══ */

const { flags } = parseArgs();
if (flags.help || flags.h) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}
const dir = resolve(flags.dir && flags.dir !== true ? String(flags.dir) : join(REPO_ROOT, 'scripts/probe/report'));
const report = build({
  dir,
  seed: flags.seed !== undefined ? intArg(flags, 'seed', undefined) : undefined,
  iters: intArg(flags, 'iters', 20000),
  exact: !flags['no-exact'],
});

if (flags.json) console.log(JSON.stringify(report, null, 2));
else print(report);

const failed = report.self_checks.filter((c) => !c.ok);
if (flags.check && failed.length) {
  console.error(`\n  ✘ ${failed.length} self-check(s) failed — see above. Figures are NOT safe to quote.\n`);
  process.exit(1);
}
