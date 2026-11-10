// The path score table build's pure half (#373, ADR 0009): the reviewed-tree check, the table plan of each step
// count, the difficulty re-check and the committed summary. Package-free, like the other booth scripts, so CI tests it
// with no install.
import treeHash from '../../backend/src/booth-cases/tree-sha.js';
import pleGate from '../../backend/src/services/ple-gate.js';
import { PATH_GROUPS, verdicts } from './sandbox-verdict.mjs';
import { FITTED_RANGE, tierPaths, fractionalDesign, fitTable, mislabels, wholeComposite } from './path-fit.mjs';

const { canonical, treeSha } = treeHash;
const { compositeScore } = pleGate;
export { treeSha };

/**
 * Whether a case's tree is the one its safety review read. The review read the tree of the first commit that holds
 * that review (the review is recorded in the case's PR, after its fixes), so the current tree must hash the same.
 * @param {{ commit: string, raw: object }[]} history the case file at each commit that touched it, oldest first
 * @param {object} current the case file as it is now
 * @returns {{ tree_sha256: string, reviewed_commit: string } | { why: string }}
 */
export function reviewedTree(history, current) {
  const review = current?.admission?.safety_review;
  if (!review) return { why: 'has no safety review' };
  const reviewed = history.find((v) => canonical(v.raw?.admission?.safety_review) === canonical(review));
  if (!reviewed) return { why: 'has a safety review that no commit holds' };
  const sha = treeSha(reviewed.raw);
  if (treeSha(current) !== sha) return { why: `changed its tree since the safety review in ${reviewed.commit.slice(0, 8)}` };
  return { tree_sha256: sha, reviewed_commit: reviewed.commit };
}

/** The table entry of one path: per domain, the median of its samples' whole scores (an odd count, so a whole). */
export function medianDomains(samples) {
  if (!samples.length || samples.length % 2 === 0) throw new Error(`a median needs an odd number of samples, got ${samples.length}`);
  return Object.fromEntries(Object.keys(samples[0]).map((k) => {
    const xs = samples.map((s) => s[k]).sort((a, b) => a - b);
    return [k, xs[(xs.length - 1) / 2]];
  }));
}

function medianPlan() {
  const sampled = tierPaths(3);
  return {
    method: 'median',
    sampled,
    build(samplesOf) {
      const paths = Object.fromEntries(sampled.map((p) => [p, medianDomains(samplesOf(p))]));
      return { paths, composites: Object.fromEntries(sampled.map((p) => [p, compositeScore(paths[p])])) };
    },
  };
}

function regressionPlan(scripted) {
  const sampled = fractionalDesign(Object.values(scripted));
  return {
    method: 'median-regression',
    sampled,
    build(samplesOf) {
      const fit = fitTable(sampled.flatMap((path) => samplesOf(path).map((domains) => ({ path, domains }))));
      return {
        paths: fit.paths,
        composites: Object.fromEntries(Object.entries(fit.paths).map(([p, domains]) => [p, wholeComposite(domains)])),
        mislabels: mislabels(fit.effects),
      };
    },
  };
}

const PLANS = Object.freeze({ 3: medianPlan, 5: regressionPlan });

/**
 * How a case of `steps` steps gets its table (ADR 0009). Three steps: every one of the 27 tier paths is sampled and
 * each entry is the median per domain. Five steps: a balanced 27 of the 243 are sampled, and a median (L1) regression
 * of each domain on step × tier fills all 243. `build` reads each sampled path's sample domains from `samplesOf`.
 * @param {number} steps
 * @param {Record<string, string>} scripted the tier path of each scripted group, which the plan samples
 * @returns {{ method: string, sampled: string[], build: (samplesOf: (path: string) => object[]) =>
 *   { paths: Record<string, object>, composites: Record<string, number>, mislabels?: object[] } }}
 */
export function tablePlan(steps, scripted) {
  const plan = PLANS[steps];
  if (!plan) throw new Error(`no path score table method for ${steps}-step cases, only ${Object.keys(PLANS).join(' and ')}`);
  return plan(scripted);
}

/**
 * ADR 0005's difficulty check, re-run on the table's own samples: each scripted group is its path's sample
 * composites (best, mixed and weakest, as the sandbox plays them), judged against this build's pool.
 * @param {Record<string, Record<string, number[]>>} composites per case id, then per tier path
 * @param {Record<string, string>} paths the tier path of each scripted group
 */
export function recheck(composites, paths, { samples, incomplete } = {}) {
  const table = Object.fromEntries(Object.entries(composites).map(([id, byPath]) => [id,
    Object.fromEntries(PATH_GROUPS.map((g) => [g, byPath[paths[g]] ?? []]))]));
  return verdicts(table, PATH_GROUPS, { runs: Object.fromEntries(PATH_GROUPS.map((g) => [g, samples])), incomplete });
}

// How the header tells each method, after "<n> samples per ".
const METHOD_TEXT = Object.freeze({
  median: () => 'tier path, median per domain',
  'median-regression': (sampled) => `path of a balanced ${sampled.length}-path design, a median (L1) regression of each `
    + `domain on step × tier filling all ${tierPaths(sampled[0].length).length} paths, domains clamped to `
    + `${FITTED_RANGE.min}–${FITTED_RANGE.max} at one decimal, whole-number composite`,
});

/** The short summary fit to commit: each case's tree check and table, its score per sampled tier path, the re-check,
 *  and for a fitted table the likely tier mislabels. */
export function summaryMarkdown(report) {
  const ids = Object.keys(report.cases);
  const built = ids.filter((id) => report.cases[id].table);
  const failing = ids.filter((id) => report.recheck.cases[id] && !report.recheck.cases[id].pass);
  const lines = [
    `# Booth path score tables, run ${report.run_id}`,
    '',
    `${report.date}. ${report.scored} of ${report.planned} samples scored, $${report.spent_usd.toFixed(2)} spent of a `
      + `$${report.cap_usd} cap${report.stopped ? ', stopped at the cap' : ''}${report.over_cap ? ', OVER the cap' : ''}. `
      + `Evaluator ${report.evaluator?.model ?? 'none'} via rimpl (${report.evaluator?.provider ?? 'none'}), prompt `
      + `${report.evaluator?.prompt_version ?? 'none'}. ${report.samples} samples per `
      + `${METHOD_TEXT[report.method](report.sampled)}. `
      + `${built.length} of ${ids.length} cases have a table.`,
    '',
    '| Case | Version | Tree | Table | Re-check |',
    '|---|---|---|---|---|',
    ...ids.map((id) => {
      const c = report.cases[id];
      const v = report.recheck.cases[id];
      return `| ${id} | ${c.version} | ${c.tree_sha256 ? `${c.tree_sha256.slice(0, 12)} (review ${c.reviewed_commit.slice(0, 8)})` : `refused: ${c.why}`} `
        + `| ${c.table ? 'built' : c.tree_sha256 ? `none: ${c.why}` : 'none'} | ${v ? (v.pass ? 'pass' : 'FAIL') : 'not run'} |`;
    }),
    '',
    '## Difficulty re-check (ADR 0005)',
    '',
    `Each group is its tier path's ${report.samples} sample composites `
      + `(${PATH_GROUPS.map((g) => `${g} ${report.scripted[g]}`).join(', ')}), judged `
      + `against this run's pool: every group mean within its band of the pool median, and best at least `
      + `${report.recheck.gap_min} above weakest.`,
    '',
    `| Case | ${PATH_GROUPS.join(' | ')} | Best − weakest | Verdict |`,
    `|---|${PATH_GROUPS.map(() => '---').join('|')}|---|---|`,
    ...Object.entries(report.recheck.cases).map(([id, v]) => `| ${id} | ${PATH_GROUPS.map((g) => (v.means[g] == null ? 'none' : `${v.means[g]} ± ${v.sd[g]}`)).join(' | ')} | ${v.separation ?? 'none'} | ${v.pass ? 'pass' : 'FAIL'} |`),
    `| pool median (cases) | ${PATH_GROUPS.map((g) => `${report.recheck.medians[g] ?? 'none'} (${report.recheck.pool_n[g]})`).join(' | ')} | | |`,
    `| band (±) | ${PATH_GROUPS.map((g) => report.recheck.bands[g] ?? 'none').join(' | ')} | ${report.recheck.gap_min} | |`,
  ];
  if (failing.length) {
    lines.push('', '### Why cases failed', '', ...failing.map((id) => `- ${id}: ${report.recheck.cases[id].reasons.join('; ')}`),
      '', `Each failing case is left out until the owner waives it again against run ${report.run_id}, or to switch it off: `
        + `\`admission.table_waiver\` with \`run_id\` ${report.run_id} (backend/src/booth-cases/AUTHORING.md).`);
  }
  const judged = ids.filter((id) => report.cases[id].mislabels);
  if (judged.length) {
    const flagged = judged.flatMap((id) => report.cases[id].mislabels
      .map((m) => `- ${id} step ${m.step}: weaker beats best by ${m.weaker_minus_best} points`));
    lines.push('', '## Likely tier mislabels', '', 'From the fitted effects on the composite: a step whose weaker answers '
      + 'score above its best. Check that step\'s option tiers.', '',
      ...(flagged.length ? flagged : ['No step\'s weaker answers score above its best.']));
  }
  if (built.length) {
    const held = Object.keys(report.cases[built[0]].composites).length;
    const unlisted = held > report.sampled.length ? ` These are the ${report.sampled.length} sampled paths; the JSON `
      + `report holds all ${held}.` : '';
    lines.push('', '## Demo score per tier path', '', `The composite of each table entry: what a play on that path scores.${unlisted}`, '',
      `| Path | ${built.join(' | ')} |`, `|---|${built.map(() => '---').join('|')}|`,
      ...report.sampled.map((p) => `| ${p} | ${built.map((id) => report.cases[id].composites[p]).join(' | ')} |`));
  }
  return `${lines.join('\n')}\n`;
}
