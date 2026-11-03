// The physician sandbox's admission rule (ADR 0005) and its committed summary. Package-free, like the other booth
// scripts, so CI tests it with no install.

export const BAND = 10;
export const SEPARATION = 15;
// Fewer cases than this make a median that is mostly the case itself: a band check against it proves nothing.
export const MIN_POOL = 3;

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
 * Each case against the pool. A group's pool median is the median of that group's scored case means, so like is
 * compared with like: a case's best path against the pool's best paths. A case passes when every group has a
 * scored play, every group mean is within BAND of its pool median, and its best path mean is at least SEPARATION
 * above its weakest. A pool counts only cases scored in that group, and a group pooled from fewer than MIN_POOL
 * cases judges nothing, so no case passes. A run that left any play unplayed or unscored (`incomplete`) passes no
 * case either: rerun the failed cases against `pool`, an earlier complete run's medians.
 * @param {Record<string, Record<string, number[]>>} table composites per case id, then per group
 * @param {string[]} groups the groups every case must have, in report order; must include 'best' and 'weakest'
 * @param {{ pool?: { medians: Record<string, number | null>, pool_n: Record<string, number> }, incomplete?: string }} [opts]
 */
export function verdicts(table, groups, { pool, incomplete } = {}) {
  const ids = Object.keys(table);
  const means = Object.fromEntries(ids.map((id) => [id, Object.fromEntries(groups.map((g) => [g, mean(table[id][g] ?? [])]))]));
  const scoredIn = (g) => ids.map((id) => means[id][g]).filter((m) => m != null);
  const medians = pool?.medians ?? Object.fromEntries(groups.map((g) => [g, median(scoredIn(g))]));
  const poolN = pool?.pool_n ?? Object.fromEntries(groups.map((g) => [g, scoredIn(g).length]));
  const thin = groups.filter((g) => !(poolN[g] >= MIN_POOL));
  const runReasons = [
    ...(incomplete ? [`incomplete run: ${incomplete}`] : []),
    ...(thin.length ? [`no pool: ${thin.map((g) => `${g} pooled from ${poolN[g] ?? 0} case(s)`).join(', ')}, fewer than ${MIN_POOL}`] : []),
  ];
  const cases = Object.fromEntries(ids.map((id) => {
    const m = means[id];
    const reasons = [...runReasons];
    for (const g of groups) {
      if (m[g] == null) reasons.push(`${g}: no scored play`);
      else if (medians[g] == null) reasons.push(`${g}: the pool has no median`);
      else if (Math.abs(m[g] - medians[g]) > BAND) reasons.push(`${g} mean ${r2(m[g])} is ${r2(m[g] - medians[g])} from the pool median ${r2(medians[g])}`);
    }
    const separation = m.best != null && m.weakest != null ? m.best - m.weakest : null;
    if (separation != null && separation < SEPARATION) reasons.push(`best is only ${r2(separation)} above weakest`);
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
      + `$${report.cap_usd} cap${report.stopped ? ', stopped at the cap' : ''}. Evaluator via rimpl (${report.providers.join(', ') || 'none'}); `
      + `personas on ${report.persona_model}.`,
    '',
    `Pool medians from ${verdict.pool_from}. Rule: every group mean within ±${BAND} of that group's pool median, and best at least ${SEPARATION} above weakest. `
      + `Scripted paths play once; each persona plays ${report.persona_runs} times (mean ± SD). ${passed.length} of ${ids.length} cases pass.`,
    '',
    `| Case | Version | ${groups.join(' | ')} | Best − weakest | Unscored | Persona fallbacks | Verdict |`,
    `|---|---|${groups.map(() => '---').join('|')}|---|---|---|---|`,
    ...ids.map((id) => {
      const c = verdict.cases[id];
      return `| ${id} | ${report.cases[id].version} | ${groups.map((g) => cell(c.means[g], c.sd[g])).join(' | ')} | ${c.separation ?? 'none'} | ${report.cases[id].unscored} | ${report.cases[id].fallbacks} | ${c.pass ? 'pass' : 'FAIL'} |`;
    }),
    `| pool median (cases) | | ${groups.map((g) => `${verdict.medians[g] ?? 'none'} (${verdict.pool_n[g]})`).join(' | ')} | | | | |`,
  ];
  const failing = ids.filter((id) => !verdict.cases[id].pass);
  if (failing.length) lines.push('', '## Why cases failed', '', ...failing.map((id) => `- ${id}: ${verdict.cases[id].reasons.join('; ')}`));
  return `${lines.join('\n')}\n`;
}
