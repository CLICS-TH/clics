// The physician sandbox's admission rule (ADR 0005) and its committed summary. Package-free, like the other booth
// scripts, so CI tests it with no install.

// How much one scored play of the same path or persona moves between runs, measured on #264's two full NFCME-2026
// runs (sbx-202611030444-53e3 and sbx-202611030514-de2b, #344). path: the 33 scripted plays that ran in both, whose
// run-to-run differences d (median 3, max 21) give sigma = sqrt(mean(d^2) / 2) = 4.91; the heavy tail is kept, not
// trimmed (the robust median-based estimate is 3.15). persona: the pooled within-run SD of each persona's 3 runs
// per case, 6.92 on 129 degrees of freedom. Rerun scripts/booth/sandbox-noise.mjs on new reports to remeasure.
export const SIGMA = Object.freeze({ path: 4.91, persona: 6.92 });
export const PATH_GROUPS = Object.freeze(['best', 'mixed', 'weakest']);
// The chance that a case whose true difficulty sits on the pool median fails its band checks on noise alone, over
// all of its groups together (Bonferroni across the groups).
export const BAND_ALPHA = 0.05;
// The chance that a case whose best and weakest paths truly score alike passes the separation check on noise.
export const GAP_ALPHA = 0.05;
// Fewer cases than this make a median that is mostly the case itself: a band check against it proves nothing.
export const MIN_POOL = 3;

/**
 * A run judges one step count (#380): three-step and five-step composites sit on different scales, so a pool of both
 * fails every case. Returns why the run is refused, or null. A pooled report from before #380 played three steps.
 * @param {number[]} caseSteps each case's step count
 * @param {{ steps?: number } | null} [poolReport] the --pool report, if any
 */
export function stepCountProblem(caseSteps, poolReport) {
  const counts = [...new Set(caseSteps)].sort();
  if (counts.length > 1) return `the cases have ${counts.join(' and ')} steps: a run judges one step count, so pick its cases with --case`;
  const poolSteps = poolReport ? poolReport.steps ?? 3 : counts[0];
  if (poolSteps !== counts[0]) return `the --pool report played ${poolSteps}-step cases and these have ${counts[0]}: pool medians from the same step count`;
  return null;
}

const sigmaOf = (g) => (PATH_GROUPS.includes(g) ? SIGMA.path : SIGMA.persona);

// Abramowitz and Stegun 7.1.26 (error under 1.5e-7), inverted by bisection: the standard normal quantile.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}
export function normalQuantile(p) {
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if ((1 + erf(mid / Math.SQRT2)) / 2 < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * How far a group mean may sit from its pool median before the distance is more than noise explains. The mean of n
 * plays has SE sigma / sqrt(n); the median of K case means adds about pi / (2K) of that variance; z splits
 * BAND_ALPHA two-sided over the case's `groupCount` groups. With 3 runs, 6 groups and 11 cases: paths 8.0,
 * personas 11.3 (the fixed ±10 it replaces sat under the noise of a single play, which alone is ±13.8).
 */
export function bandFor(g, n, poolN, groupCount) {
  const z = normalQuantile(1 - BAND_ALPHA / (2 * groupCount));
  return z * (sigmaOf(g) / Math.sqrt(n)) * Math.sqrt(1 + Math.PI / (2 * poolN));
}

/**
 * The least best − weakest gap that noise alone would reach with chance under GAP_ALPHA (one-sided): the case's
 * scripted paths separate good reasoning from bad. Judged on the scripted means because the personas do not order by
 * skill on this evaluator: strong − weak averaged near 0 and was negative on 3 of 11 cases over both runs (#344),
 * while best − weakest was positive on all 11. With 3 runs each: 6.6 (the fixed 15 it replaces exceeded the pool's
 * own median gap, 48 − 35 = 13, on the evaluator's compressed scale).
 */
export function gapFor(nBest, nWeakest) {
  return normalQuantile(1 - GAP_ALPHA) * SIGMA.path * Math.sqrt(1 / nBest + 1 / nWeakest);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * Each case against the pool. A group's pool median is the median of that group's case means, so like is compared
 * with like: a case's best paths against the pool's best paths. Only a group with every planned play scored has a
 * mean: it alone enters the pool and can pass. A case passes when every group is complete, every group mean is
 * within that group's band (bandFor) of its pool median, and its best path mean beats its weakest by gapFor. An
 * unscored play fails its own case only. A group pooled from fewer than MIN_POOL complete cases judges nothing, and
 * a run cut short by the spend cap (`incomplete`) passes no case: rerun against `pool`, an earlier full run's.
 * @param {Record<string, Record<string, number[]>>} table composites per case id, then per group
 * @param {string[]} groups the groups every case must have, in report order; must include 'best' and 'weakest'
 * @param {{ pool?: { medians: Record<string, number | null>, pool_n: Record<string, number> }, incomplete?: string,
 *   runs?: Record<string, number>, averaged?: Record<string, number> }} [opts] runs: plays planned per group, per case
 *   (default 1); averaged: how many plays' mean a group's value is as noisy as, which sizes its band and the gap
 *   (default runs)
 */
export function verdicts(table, groups, { pool, incomplete, runs = {}, averaged = {} } = {}) {
  const ids = Object.keys(table);
  const planned = (g) => runs[g] ?? 1;
  const noise = (g) => averaged[g] ?? planned(g);
  const complete = (id, g) => (table[id][g] ?? []).length >= planned(g);
  const means = Object.fromEntries(ids.map((id) => [id, Object.fromEntries(groups.map((g) => [g, complete(id, g) ? mean(table[id][g]) : null]))]));
  const pooledIn = (g) => ids.map((id) => means[id][g]).filter((m) => m != null);
  const medians = pool?.medians ?? Object.fromEntries(groups.map((g) => [g, median(pooledIn(g))]));
  const poolN = pool?.pool_n ?? Object.fromEntries(groups.map((g) => [g, pooledIn(g).length]));
  const thin = groups.filter((g) => !(poolN[g] >= MIN_POOL));
  const bands = Object.fromEntries(groups.map((g) => [g, thin.includes(g) ? null : bandFor(g, noise(g), poolN[g], groups.length)]));
  const gapMin = gapFor(noise('best'), noise('weakest'));
  const runReasons = [
    ...(incomplete ? [`incomplete run: ${incomplete}`] : []),
    ...(thin.length ? [`no pool: ${thin.map((g) => `${g} pooled from ${poolN[g] ?? 0} case(s)`).join(', ')}, fewer than ${MIN_POOL}`] : []),
  ];
  const cases = Object.fromEntries(ids.map((id) => {
    const m = means[id];
    const reasons = [...runReasons];
    for (const g of groups) {
      const scored = (table[id][g] ?? []).length;
      if (m[g] == null) reasons.push(`${g}: ${scored} of ${planned(g)} plays scored`);
      else if (medians[g] == null) reasons.push(`${g}: the pool has no median`);
      else if (bands[g] != null && Math.abs(m[g] - medians[g]) > bands[g]) {
        reasons.push(`${g} mean ${r2(m[g])} is ${r2(m[g] - medians[g])} from the pool median ${r2(medians[g])}, beyond ±${r2(bands[g])}`);
      }
    }
    const separation = m.best != null && m.weakest != null ? m.best - m.weakest : null;
    if (separation != null && separation < gapMin) reasons.push(`best is only ${r2(separation)} above weakest, under ${r2(gapMin)}`);
    return [id, {
      means: Object.fromEntries(groups.map((g) => [g, r2(m[g])])),
      sd: Object.fromEntries(groups.map((g) => [g, r2(sd(table[id][g] ?? []))])),
      separation: r2(separation),
      pass: reasons.length === 0,
      reasons,
    }];
  }));
  return {
    medians: Object.fromEntries(groups.map((g) => [g, r2(medians[g])])),
    pool_n: Object.fromEntries(groups.map((g) => [g, poolN[g] ?? 0])),
    bands: Object.fromEntries(groups.map((g) => [g, r2(bands[g])])),
    gap_min: r2(gapMin),
    pool_from: pool ? 'earlier run' : 'this run',
    cases,
  };
}

const cell = (m, s) => (m == null ? 'none' : s == null ? `${m}` : `${m} ± ${s}`);

/** The short summary fit to commit: one row per case, the pool medians, and why each failing case failed. */
export function summaryMarkdown(report, groups) {
  const { verdict } = report;
  const ids = Object.keys(verdict.cases);
  const passed = ids.filter((id) => verdict.cases[id].pass);
  const lines = [
    `# Booth physician sandbox, run ${report.run_id}`,
    '',
    `${report.date}. ${report.scored} of ${report.planned} plays scored, $${report.spent_usd.toFixed(2)} spent of a `
      + `$${report.cap_usd} cap${report.stopped ? ', stopped at the cap' : ''}${report.over_cap ? ', OVER the cap' : ''}. Evaluator via rimpl (${report.providers.join(', ') || 'none'}); `
      + `personas on ${report.persona_model}.`,
    '',
    `Pool medians from ${verdict.pool_from}. Rule: every group mean within its band (the row below, sized from the `
      + `measured play-to-play noise) of that group's pool median, and best at least ${verdict.gap_min} above weakest. `
      + `Each scripted path plays ${report.path_runs} times and each persona ${report.persona_runs} times (mean ± SD). `
      + `${passed.length} of ${ids.length} cases pass.`,
    '',
    `| Case | Version | ${groups.join(' | ')} | Best − weakest | Unscored | Persona fallbacks | Verdict |`,
    `|---|---|${groups.map(() => '---').join('|')}|---|---|---|---|`,
    ...ids.map((id) => {
      const c = verdict.cases[id];
      return `| ${id} | ${report.cases[id].version} | ${groups.map((g) => cell(c.means[g], c.sd[g])).join(' | ')} | ${c.separation ?? 'none'} | ${report.cases[id].unscored} | ${report.cases[id].fallbacks} | ${c.pass ? 'pass' : 'FAIL'} |`;
    }),
    `| pool median (cases) | | ${groups.map((g) => `${verdict.medians[g] ?? 'none'} (${verdict.pool_n[g]})`).join(' | ')} | | | | |`,
    `| band (±) | | ${groups.map((g) => verdict.bands[g] ?? 'none').join(' | ')} | ${verdict.gap_min} | | | |`,
  ];
  const failing = ids.filter((id) => !verdict.cases[id].pass);
  if (failing.length) lines.push('', '## Why cases failed', '', ...failing.map((id) => `- ${id}: ${verdict.cases[id].reasons.join('; ')}`));
  return `${lines.join('\n')}\n`;
}
