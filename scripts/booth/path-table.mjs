// The path score table build's pure half (#373, ADR 0009): the reviewed-tree check, the table plan of each step
// count, the difficulty re-check and the committed summary. Package-free, like the other booth scripts, so CI tests it
// with no install.
import treeHash from '../../backend/src/booth-cases/tree-sha.js';
import pleGate from '../../backend/src/services/ple-gate.js';
import { PATH_GROUPS, verdicts } from './sandbox-verdict.mjs';
import { FITTED_RANGE, tierPaths, fractionalDesign, fitTable, mislabels, wholeComposite } from './path-fit.mjs';

const { canonical, treeSha, reviewedSha } = treeHash;
const { compositeScore } = pleGate;
export { treeSha };

/**
 * Whether a case's tree is the one its safety review read. The review names that tree by its hash, so a tree edited in
 * the commit that copies the review in (a move from staging, #468) is refused. The hash in `tree_sha256` is written by
 * whoever moves the case, so it counts only while it is the hash the reviewer's own `findings` name (reviewedSha): an
 * edit with a recomputed `tree_sha256` is refused (#386). The review also read the tree of the first commit that holds
 * it (the review is recorded in the case's PR, after its fixes), so that tree must hash the same.
 * @param {{ commit: string, raw: object }[]} history the case file at each commit that touched it, oldest first
 * @param {object} current the case file as it is now
 * @returns {{ tree_sha256: string, reviewed_commit: string } | { why: string }}
 */
export function reviewedTree(history, current) {
  const review = current?.admission?.safety_review;
  if (!review) return { why: 'has no safety review' };
  if (!review.tree_sha256) return { why: 'has a safety review that names no tree (no tree_sha256)' };
  const named = reviewedSha(review.findings);
  if (!named) return { why: 'has a safety review whose findings name no tree (no "tree sha256 <hash>")' };
  if (named !== review.tree_sha256) return { why: `has a tree_sha256 that is not the tree its reviewer read (the findings name ${named.slice(0, 12)})` };
  if (review.tree_sha256 !== treeSha(current)) return { why: 'has a safety review of another tree (its tree_sha256 is not this tree\'s hash)' };
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

function medianPlan(scripted) {
  const sampled = tierPaths(3);
  return {
    method: 'median',
    scripted,
    sampled,
    build(samplesOf) {
      const paths = Object.fromEntries(sampled.map((p) => [p, medianDomains(samplesOf(p))]));
      return { paths, composites: Object.fromEntries(sampled.map((p) => [p, compositeScore(paths[p])])) };
    },
    judged: ({ composites }, path) => composites[path] ?? [],
    runs: (samples) => samples,
  };
}

function regressionPlan(scripted) {
  const sampled = fractionalDesign(Object.values(scripted));
  return {
    method: 'median-regression',
    scripted,
    sampled,
    build(samplesOf) {
      const fit = fitTable(sampled.flatMap((path) => samplesOf(path).map((domains) => ({ path, domains }))));
      return {
        paths: fit.paths,
        composites: Object.fromEntries(Object.entries(fit.paths).map(([p, domains]) => [p, wholeComposite(domains)])),
        mislabels: mislabels(fit.effects),
      };
    },
    judged: ({ table }, path) => (table ? [table.composites[path]] : []),
    runs: () => 1,
  };
}

const PLANS = Object.freeze({ 3: medianPlan, 5: regressionPlan });

/**
 * How a case of `steps` steps gets its table (ADR 0009). Three steps: every one of the 27 tier paths is sampled and
 * each entry is the median per domain. Five steps: a balanced 27 of the 243 are sampled, and a median (L1) regression
 * of each domain on step × tier fills all 243. `build` reads each sampled path's sample domains from `samplesOf`.
 * `judged` is what the difficulty re-check reads for a case's scripted path, and `runs` how many values that is: three
 * steps, the path's sample composites, as the sandbox plays them; five steps, the path's fitted entry, the whole
 * composite its plays score.
 * @param {number} steps
 * @param {Record<string, string>} scripted the tier path of each scripted group, which the plan samples
 * @returns {{ method: string, scripted: Record<string, string>, sampled: string[],
 *   build: (samplesOf: (path: string) => object[]) =>
 *     { paths: Record<string, object>, composites: Record<string, number>, mislabels?: object[] },
 *   judged: (c: { composites: Record<string, number[]>, table: object | null }, path: string) => number[],
 *   runs: (samples: number) => number }}
 */
export function tablePlan(steps, scripted) {
  const plan = PLANS[steps];
  if (!plan) throw new Error(`no path score table method for ${steps}-step cases, only ${Object.keys(PLANS).join(' and ')}`);
  return plan(scripted);
}

/**
 * ADR 0005's difficulty check, re-run on this build: each scripted group (best, mixed and weakest) is what the plan
 * judges on its path, judged against this build's pool.
 * @param {ReturnType<typeof tablePlan>} plan
 * @param {Record<string, { composites: Record<string, number[]>, table: object | null }>} cases per case id, its
 *   sample composites per sampled tier path and its built table (null when it has none)
 */
export function recheck(plan, cases, { samples, incomplete } = {}) {
  const table = Object.fromEntries(Object.entries(cases).map(([id, c]) => [id,
    Object.fromEntries(PATH_GROUPS.map((g) => [g, plan.judged(c, plan.scripted[g])]))]));
  const each = (n) => Object.fromEntries(PATH_GROUPS.map((g) => [g, n]));
  // Every group counts as the mean of `samples` plays. A fitted entry pools all of its case's samples and is a little
  // steadier (fittedNoise: on 27 paths × 3, one entry about 0.21σ² against σ²/3, and best − weakest about 0.58σ²
  // against 2σ²/3), so for it the bands are a little lenient and the gap a little strict.
  return verdicts(table, PATH_GROUPS, { runs: each(plan.runs(samples)), averaged: each(samples), incomplete });
}

// The variance, in one play's σ², of a fitted entry and of a fitted best − weakest: least squares' p/N and 6k/N on a
// balanced design of N samples, times π/2 for a median fit.
function fittedNoise(sampled, samples) {
  const k = sampled[0].length;
  const n = sampled.length * samples;
  return { entry: (Math.PI / 2) * ((1 + 2 * k) / n), gap: (Math.PI / 2) * ((6 * k) / n) };
}

// How the summary tells each method: what a build samples, after "<n> samples per ", and what its re-check judges.
const METHOD_TEXT = Object.freeze({
  median: {
    sampling: () => 'tier path, median per domain',
    judged: (report, scripted) => `Each group is its tier path's ${report.samples} sample composites (${scripted}), `
      + 'judged against this run\'s pool: every group mean within its band of the pool median, and best at least '
      + `${report.recheck.gap_min} above weakest.`,
  },
  'median-regression': {
    sampling: (report) => `path of a balanced ${report.sampled.length}-path design, a median (L1) regression of each `
      + `domain on step × tier filling all ${tierPaths(report.sampled[0].length).length} paths, domains clamped to `
      + `${FITTED_RANGE.min}–${FITTED_RANGE.max} at one decimal, whole-number composite`,
    judged: (report, scripted) => {
      const n = report.samples;
      const noise = fittedNoise(report.sampled, n);
      return `Each group is the fitted table's entry for its tier path (${scripted}): the whole composite a play on `
        + 'that path scores, not the path\'s sample composites. Each entry is judged as the mean of '
        + `${n} plays against this run's pool: every entry within its band of the pool median, and best at least `
        + `${report.recheck.gap_min} above weakest. A fitted entry draws on all ${report.sampled.length * n} of the `
        + `case's samples, so it is steadier than a ${n}-play mean. One entry's noise is about `
        + `${noise.entry.toFixed(2)}σ², not σ²/${n}, so the bands are a little lenient. Best − weakest's is about `
        + `${noise.gap.toFixed(2)}σ², not 2σ²/${n}, so the gap is a little strict. Here σ² is one play's variance.`;
    },
  },
});

const scoreCell = (mean, sd) => (mean == null ? 'none' : sd == null ? `${mean}` : `${mean} ± ${sd}`);

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
      + `${METHOD_TEXT[report.method].sampling(report)}. `
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
    METHOD_TEXT[report.method].judged(report, PATH_GROUPS.map((g) => `${g} ${report.scripted[g]}`).join(', ')),
    '',
    `| Case | ${PATH_GROUPS.join(' | ')} | Best − weakest | Verdict |`,
    `|---|${PATH_GROUPS.map(() => '---').join('|')}|---|---|`,
    ...Object.entries(report.recheck.cases).map(([id, v]) => `| ${id} | ${PATH_GROUPS.map((g) => scoreCell(v.means[g], v.sd[g])).join(' | ')} | ${v.separation ?? 'none'} | ${v.pass ? 'pass' : 'FAIL'} |`),
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
